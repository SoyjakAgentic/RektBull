//! The order program against pump.fun's real program, on a local chain holding copies of pump.fun's program,
//! its fee program and one live bonding curve from mainnet (scripts/pump_fixtures.py saves them in
//! solana/fixtures/pump/). Ignored by default because it needs those copies:
//!
//!   python3 -I scripts/pump_fixtures.py && cargo build-sbf --arch v0 && cargo test -p rektbull-orders --test pump_fun -- --ignored
//!
//! It checks, with pump.fun's current v3 instructions and transit as pump.fun's trader:
//! - a signed limit buy paid in wrapped SOL, sent to pump.fun as native SOL, filled by the executor key at
//!   pump.fun's own price, with 1% to the fee wallet;
//! - a limit pump.fun can't meet, refused;
//! - a signed stop-loss sale back for native SOL, 1% to the fee wallet;
//! - transit left holding nothing.

use anchor_lang::prelude::{AccountMeta as AnchorMeta, Pubkey};
use anchor_lang::solana_program::{program_option::COption, program_pack::Pack, system_program};
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::associated_token::{get_associated_token_address_with_program_id as ata, spl_associated_token_account};
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022;
use base64::Engine;
use litesvm::LiteSVM;
use rektbull_orders::{OrderParams, DELEGATE_SEED, FEE_WALLET, ORDER_SEED, PUMP_FUN, TRANSIT_SEED, WSOL_MINT};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

const SOL: u64 = 1_000_000_000;
const FEE_PROGRAM: &str = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";

fn a(p: &Pubkey) -> Address { Address::new_from_array(p.to_bytes()) }
fn pk(x: &Address) -> Pubkey { Pubkey::new_from_array(x.to_bytes()) }
fn key(k: &Keypair) -> Pubkey { pk(&k.pubkey()) }
fn root() -> String { format!("{}/../..", env!("CARGO_MANIFEST_DIR")) }
fn fixtures() -> String { format!("{}/fixtures/pump", root()) }
fn delegate() -> Pubkey { Pubkey::find_program_address(&[DELEGATE_SEED], &rektbull_orders::ID).0 }
fn transit() -> Pubkey { Pubkey::find_program_address(&[TRANSIT_SEED], &rektbull_orders::ID).0 }
fn ix(program: Pubkey, metas: Vec<AnchorMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: a(&program),
        accounts: metas.into_iter().map(|m| AccountMeta { pubkey: a(&m.pubkey), is_signer: m.is_signer, is_writable: m.is_writable }).collect(),
        data,
    }
}
fn w(p: Pubkey) -> AnchorMeta { AnchorMeta::new(p, false) }
fn r(p: Pubkey) -> AnchorMeta { AnchorMeta::new_readonly(p, false) }
/// An Anchor instruction id: the first 8 bytes of sha256("global:<name>") (pump.fun is an Anchor program).
fn disc(name: &str) -> Vec<u8> { use sha2::Digest; sha2::Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec() }

struct Pump {
    svm: LiteSVM,
    c: serde_json::Value,
    mint: Pubkey,
    mint_program: Pubkey,
    user: Keypair,
    exec: Keypair,
}

impl Pump {
    fn new() -> Pump {
        let curves: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/curves.json", fixtures())).expect("run scripts/pump_fixtures.py first")).unwrap();
        let c = curves["v3"].clone();
        assert!(c.is_object(), "the fixtures have no v3 curve; run scripts/pump_fixtures.py again");
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(a(&rektbull_orders::ID), format!("{}/target/deploy/rektbull_orders.so", root())).unwrap();
        svm.add_program_from_file(a(&PUMP_FUN), format!("{}/pump.so", fixtures())).unwrap();
        svm.add_program_from_file(a(&Pubkey::from_str(FEE_PROGRAM).unwrap()), format!("{}/pump_fees.so", fixtures())).unwrap();
        for name in ["global", "base_mint", "bonding_curve", "associated_base_bonding_curve", "fee_config", "buyback_fee_recipient", "event_authority"] {
            let path = format!("{}/v3_{name}.json", fixtures());
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let j: serde_json::Value = serde_json::from_str(&text).unwrap();
            let address = Pubkey::from_str(j["address"].as_str().unwrap()).unwrap();
            let data = base64::engine::general_purpose::STANDARD.decode(j["data"].as_str().unwrap()).unwrap();
            let owner = Pubkey::from_str(j["owner"].as_str().unwrap()).unwrap();
            svm.set_account(a(&address), Account { lamports: j["lamports"].as_u64().unwrap(), data, owner: a(&owner), executable: false, rent_epoch: 0 }).unwrap();
        }
        // The chain's clock at the trade the copies came from.
        let mut clock = svm.get_sysvar::<solana_clock::Clock>();
        clock.unix_timestamp = c["block_time"].as_i64().unwrap();
        clock.slot = c["slot"].as_u64().unwrap();
        svm.set_sysvar(&clock);
        let mint = Pubkey::from_str(c["base_mint"].as_str().unwrap()).unwrap();
        let mint_program = Pubkey::from_str(c["base_token_program"].as_str().unwrap()).unwrap();
        let (user, exec) = (Keypair::new(), Keypair::new());
        let mut p = Pump { svm, c, mint, mint_program, user, exec };
        p.set_lamports(key(&p.user), 10 * SOL);
        p.set_lamports(key(&p.exec), 10 * SOL);
        p.set_lamports(FEE_WALLET, SOL);
        // Wrapped SOL's mint, as on mainnet.
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        spl_token::state::Mint { mint_authority: COption::None, supply: 0, decimals: 9, is_initialized: true, freeze_authority: COption::None }.pack_into_slice(&mut data);
        p.svm.set_account(a(&WSOL_MINT), Account { lamports: 1_461_600, data, owner: a(&spl_token::ID), executable: false, rent_epoch: 0 }).unwrap();
        p
    }
    fn acct(&self, name: &str) -> Pubkey { Pubkey::from_str(self.c[name].as_str().unwrap()).unwrap() }
    fn lamports(&self, p: Pubkey) -> u64 { self.svm.get_balance(&a(&p)).unwrap_or(0) }
    fn set_lamports(&mut self, p: Pubkey, lamports: u64) {
        self.svm.set_account(a(&p), Account { lamports, data: vec![], owner: a(&system_program::ID), executable: false, rent_epoch: 0 }).unwrap();
    }
    fn token_balance(&self, p: Pubkey) -> u64 {
        let acc = self.svm.get_account(&a(&p)).unwrap();
        u64::from_le_bytes(acc.data[64..72].try_into().unwrap()) // the amount field, the same in Token and Token-2022
    }
    /// A classic-token wrapped SOL account holding `amount`.
    fn wsol_account(&mut self, owner: Pubkey, amount: u64) -> Pubkey {
        let address = Pubkey::new_unique();
        let rent = self.svm.minimum_balance_for_rent_exemption(spl_token::state::Account::LEN);
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        spl_token::state::Account { mint: WSOL_MINT, owner, amount, delegate: COption::None, state: spl_token::state::AccountState::Initialized,
            is_native: COption::Some(rent), delegated_amount: 0, close_authority: COption::None }.pack_into_slice(&mut data);
        self.svm.set_account(a(&address), Account { lamports: rent + amount, data, owner: a(&spl_token::ID), executable: false, rent_epoch: 0 }).unwrap();
        address
    }
    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        let payer = signers[0].pubkey();
        let message = Message::new(ixs, Some(&payer));
        let size = 1 + 64 * signers.len() + message.serialize().len();
        assert!(size <= 1232, "the transaction is {size} bytes, over Solana's 1,232");
        if ixs.iter().any(|i| i.program_id == a(&rektbull_orders::ID)) { println!("transaction: {size} bytes"); }
        let tx = Transaction::new(signers, message, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res.map(|_| ()).map_err(|e| format!("{:?} :: {}", e.err, e.meta.logs.join(" | ")))
    }
    /// The canonical token account of `owner` for the coin, created by the executor (as the trade service would).
    fn coin_ata(&mut self, owner: Pubkey) -> Pubkey {
        let i = spl_associated_token_account::instruction::create_associated_token_account_idempotent(&key(&self.exec), &owner, &self.mint, &self.mint_program);
        let exec = self.exec.insecure_clone();
        self.send(&[ix(i.program_id, i.accounts, i.data)], &[&exec]).unwrap();
        ata(&owner, &self.mint, &self.mint_program)
    }
    fn place(&mut self, nonce: u64, p: OrderParams) -> Pubkey {
        let user = self.user.insecure_clone();
        let order = Pubkey::find_program_address(&[ORDER_SEED, key(&user).as_ref(), &nonce.to_le_bytes()], &rektbull_orders::ID).0;
        let metas = rektbull_orders::accounts::PlaceOrder { owner: key(&user), order, system_program: system_program::ID }.to_account_metas(None);
        self.send(&[ix(rektbull_orders::ID, metas, rektbull_orders::instruction::PlaceOrder { nonce, p }.data())], &[&user]).unwrap();
        order
    }
    fn params(&self, input: Pubkey, output: Pubkey, native: bool, amount_in: u64, min_out: u64) -> OrderParams {
        let now = self.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
        OrderParams { executor: key(&self.exec), input_mint: input, output_mint: output, output_native: native, amount_in, min_amount_out: min_out, valid_after: 0, valid_until: now + 3600 }
    }
    /// pump.fun v3's accounts, with transit as the trader.
    fn pump_accounts(&self, transit_coin: Pubkey) -> Vec<AnchorMeta> {
        let curve = self.acct("bonding_curve");
        vec![
            r(self.acct("global")), r(self.mint), r(WSOL_MINT), r(self.mint_program), r(spl_token::ID),
            w(curve), w(self.acct("associated_base_bonding_curve")), w(ata(&curve, &WSOL_MINT, &spl_token::ID)), // ignored on a SOL quote
            w(transit()), w(transit_coin), w(ata(&transit(), &WSOL_MINT, &spl_token::ID)), // ignored on a SOL quote
            w(Pubkey::find_program_address(&[b"user_volume_accumulator", transit().as_ref()], &PUMP_FUN).0),
            r(self.acct("fee_config")), w(self.acct("buyback_fee_recipient")), r(system_program::ID), r(self.acct("event_authority")), r(PUMP_FUN),
        ]
    }
    #[allow(clippy::too_many_arguments)]
    fn fill(&mut self, order: Pubkey, source: Pubkey, input_mint: Pubkey, input_program: Pubkey, transit_in: Pubkey, out: Option<(Pubkey, Pubkey)>,
            amount_in: u64, unwrap_in: bool, venue_data: Vec<u8>, transit_coin: Pubkey) -> Result<(), String> {
        let mut metas = rektbull_orders::accounts::Fill {
            executor: key(&self.exec), order, owner: key(&self.user), delegate: delegate(), transit: transit(),
            source, input_mint, transit_in, input_token_program: input_program,
            output_mint: out.map(|_| self.mint), transit_out: out.map(|o| o.0), owner_out: out.map(|o| o.1), output_token_program: out.map(|_| self.mint_program),
            fee_wallet: FEE_WALLET, fee_in: None, fee_out: None, venue: PUMP_FUN, system_program: system_program::ID,
        }
        .to_account_metas(None);
        metas.extend(self.pump_accounts(transit_coin));
        let data = rektbull_orders::instruction::Fill { amount_in, unwrap_in, venue_data }.data();
        let exec = self.exec.insecure_clone();
        self.send(&[ix(rektbull_orders::ID, metas, data)], &[&exec])
    }
}

/// buy_exact_quote_in_v3(spendable_quote_in, min_tokens_out, partial_fill = false)
fn pump_buy(spend: u64, min_tokens: u64) -> Vec<u8> {
    let mut d = disc("buy_exact_quote_in_v3");
    d.extend_from_slice(&spend.to_le_bytes());
    d.extend_from_slice(&min_tokens.to_le_bytes());
    d.push(0);
    d
}
/// sell_v3(amount, min_sol_output)
fn pump_sell(amount: u64, min_sol: u64) -> Vec<u8> {
    let mut d = disc("sell_v3");
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&min_sol.to_le_bytes());
    d
}

#[test]
#[ignore = "needs mainnet copies: python3 -I scripts/pump_fixtures.py"]
fn pump_fun_buy_and_sell_through_the_order_program() {
    let mut p = Pump::new();
    let user = p.user.insecure_clone();
    let transit_coin = p.coin_ata(transit());
    let user_coin = p.coin_ata(key(&user));
    // One-time setup, paid by the executor: pump.fun's volume account for transit. (Without it, pump.fun would
    // create it on the first trade with rent taken from transit, i.e. from that user's SOL.)
    let uva = Pubkey::find_program_address(&[b"user_volume_accumulator", transit().as_ref()], &PUMP_FUN).0;
    let init = ix(PUMP_FUN, vec![AnchorMeta::new(key(&p.exec), true), r(transit()), w(uva), r(system_program::ID), r(p.acct("event_authority")), r(PUMP_FUN)], disc("init_user_volume_accumulator"));
    let exec = p.exec.insecure_clone();
    p.send(&[init], &[&exec]).expect("pump.fun's init_user_volume_accumulator for transit");
    let uva_account = p.svm.get_account(&a(&uva)).unwrap();
    println!("pump.fun's volume account for transit: {} bytes, {} lamports of rent (paid by the executor)", uva_account.data.len(), uva_account.lamports);

    // 1. A limit buy: 0.1 SOL of wrapped SOL for at least 1 token unit (the price check is the next step).
    let user_wsol = p.wsol_account(key(&user), SOL);
    let approve = spl_token::instruction::approve(&spl_token::ID, &user_wsol, &delegate(), &key(&user), &[], SOL / 10).unwrap();
    p.send(&[ix(spl_token::ID, approve.accounts, approve.data)], &[&user]).unwrap();
    let order = p.place(1, p.params(WSOL_MINT, p.mint, false, SOL / 10, 1));
    // After RektBull's 1%, less 0.001 SOL of headroom: pump.fun also takes a small fixed amount from the trader on
    // top of spendable_quote_in (552,720 lamports here; an ordinary wallet pays the same). The trade service sizes
    // this from a simulation; whatever isn't used comes back to the user.
    let spend = SOL / 10 - SOL / 1000 - SOL / 1000;
    let transit_wsol = p.wsol_account(transit(), 0);
    let (fee0, user_sol0) = (p.lamports(FEE_WALLET), p.lamports(key(&user)));
    p.fill(order, user_wsol, WSOL_MINT, spl_token::ID, transit_wsol, Some((transit_coin, user_coin)), SOL / 10, true, pump_buy(spend, 1), transit_coin)
        .expect("the buy through pump.fun");
    let bought = p.token_balance(user_coin);
    println!("bought {bought} units of {} with a 0.1 SOL order (0.001 fee, 0.098 offered to pump.fun)", p.mint);
    assert!(bought > 0, "the tokens reached the user");
    assert_eq!(p.lamports(FEE_WALLET) - fee0, SOL / 1000, "1% of the SOL in to the fee wallet");
    assert!(p.lamports(key(&user)) >= user_sol0, "any SOL pump.fun didn't use came back (and the order's rent)");
    assert_eq!(p.lamports(transit()), 0, "transit holds nothing");
    assert_eq!(p.token_balance(transit_coin), 0);

    // 2. The same buy with a limit pump.fun can't meet: refused, by the order program's own check.
    let user_wsol2 = p.wsol_account(key(&user), SOL);
    let approve = spl_token::instruction::approve(&spl_token::ID, &user_wsol2, &delegate(), &key(&user), &[], SOL / 10).unwrap();
    p.send(&[ix(spl_token::ID, approve.accounts, approve.data)], &[&user]).unwrap();
    let greedy = p.place(2, p.params(WSOL_MINT, p.mint, false, SOL / 10, bought * 2));
    let transit_wsol = p.wsol_account(transit(), 0);
    let err = p.fill(greedy, user_wsol2, WSOL_MINT, spl_token::ID, transit_wsol, Some((transit_coin, user_coin)), SOL / 10, true, pump_buy(spend, 1), transit_coin)
        .expect_err("a limit pump.fun can't meet");
    assert!(err.contains("BelowLimit"), "refused for the price: {err}");

    // 3. A stop-loss: sell everything bought, for native SOL.
    let approve = spl_token_2022::instruction::approve(&p.mint_program, &user_coin, &delegate(), &key(&user), &[], bought).unwrap();
    p.send(&[ix(p.mint_program, approve.accounts, approve.data)], &[&user]).unwrap();
    let sell = p.place(3, p.params(p.mint, WSOL_MINT, true, bought, 1));
    let (fee0, user_sol0) = (p.lamports(FEE_WALLET), p.lamports(key(&user)));
    p.fill(sell, user_coin, p.mint, p.mint_program, transit_coin, None, bought, false, pump_sell(bought, 1), transit_coin)
        .expect("the sale through pump.fun");
    let got = p.lamports(key(&user)) - user_sol0;
    let fee = p.lamports(FEE_WALLET) - fee0;
    println!("sold for {got} lamports to the user (including the order's rent back), {fee} to the fee wallet");
    assert!(fee > 0 && fee * 99 <= got, "1% of the SOL out to the fee wallet");
    assert_eq!(p.token_balance(user_coin), 0);
    assert_eq!(p.lamports(transit()), 0, "transit holds nothing");
    assert_eq!(p.token_balance(transit_coin), 0);
}
