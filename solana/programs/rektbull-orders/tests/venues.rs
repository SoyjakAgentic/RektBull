//! The order program against PumpSwap and Jupiter's real programs, on a local chain holding copies of them and
//! of every account the trades touch, taken from mainnet by scripts/venue_fixtures.py (solana/fixtures/venues/).
//! Ignored by default because it needs those copies:
//!
//!   python3 -I scripts/venue_fixtures.py && cargo build-sbf --arch v0 && cargo test -p rektbull-orders --test venues -- --ignored --nocapture
//!
//! Each fill is sent the way the trade service will send it: a version-0 transaction (with the exchange's address
//! lookup tables where it has them), checked against Solana's 1,232-byte limit.

use anchor_lang::prelude::{AccountMeta as AnchorMeta, Pubkey};
use anchor_lang::solana_program::{program_option::COption, program_pack::Pack, system_program};
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::associated_token::{get_associated_token_address_with_program_id as ata, spl_associated_token_account};
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022;
use base64::Engine;
use litesvm::LiteSVM;
use rektbull_orders::{OrderParams, DELEGATE_SEED, FEE_WALLET, JUPITER_V6, ORDER_SEED, PUMP_AMM, TRANSIT_SEED, USDC_MINT, WSOL_MINT};
use serde_json::Value;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::{v0, AddressLookupTableAccount, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use std::str::FromStr;

const SOL: u64 = 1_000_000_000;
const PACKET: usize = 1232; // Solana's limit for a serialized transaction

fn a(p: &Pubkey) -> Address { Address::new_from_array(p.to_bytes()) }
fn pk(x: &Address) -> Pubkey { Pubkey::new_from_array(x.to_bytes()) }
fn key(k: &Keypair) -> Pubkey { pk(&k.pubkey()) }
fn pubkey(v: &Value) -> Pubkey { Pubkey::from_str(v.as_str().unwrap()).unwrap() }
fn root() -> String { format!("{}/../..", env!("CARGO_MANIFEST_DIR")) }
fn fixtures() -> String { format!("{}/fixtures/venues", root()) }
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
/// An Anchor instruction id: the first 8 bytes of sha256("global:<name>").
fn disc(name: &str) -> Vec<u8> { use sha2::Digest; sha2::Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec() }

struct Chain {
    svm: LiteSVM,
    v: Value,
    user: Keypair,
    exec: Keypair,
}

impl Chain {
    fn new() -> Chain {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/venues.json", fixtures())).expect("run scripts/venue_fixtures.py first")).unwrap();
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(a(&rektbull_orders::ID), format!("{}/target/deploy/rektbull_orders.so", root())).unwrap();
        for entry in std::fs::read_dir(format!("{}/accounts", fixtures())).unwrap() {
            let path = entry.unwrap().path();
            let stem = Pubkey::from_str(path.file_stem().unwrap().to_str().unwrap()).unwrap();
            if path.extension().unwrap() == "so" {
                svm.add_program_from_file(a(&stem), &path).unwrap();
            } else {
                let j: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                let data = base64::engine::general_purpose::STANDARD.decode(j["data"].as_str().unwrap()).unwrap();
                svm.set_account(a(&stem), Account { lamports: j["lamports"].as_u64().unwrap(), data, owner: a(&pubkey(&j["owner"])), executable: false, rent_epoch: 0 }).unwrap();
            }
        }
        // The chain's clock at the time the copies were taken.
        let mut clock = svm.get_sysvar::<solana_clock::Clock>();
        clock.slot = v["slot"].as_u64().unwrap();
        clock.unix_timestamp = v["block_time"].as_i64().unwrap();
        svm.set_sysvar(&clock);
        svm.warp_to_slot(v["slot"].as_u64().unwrap() + 1);
        let (user, exec) = (Keypair::new(), Keypair::new());
        let mut c = Chain { svm, v, user, exec };
        for k in [key(&c.user), key(&c.exec), FEE_WALLET] { c.set_lamports(k, 10 * SOL); }
        c
    }
    fn lamports(&self, p: Pubkey) -> u64 { self.svm.get_balance(&a(&p)).unwrap_or(0) }
    fn set_lamports(&mut self, p: Pubkey, lamports: u64) {
        self.svm.set_account(a(&p), Account { lamports, data: vec![], owner: a(&system_program::ID), executable: false, rent_epoch: 0 }).unwrap();
    }
    fn exists(&self, p: Pubkey) -> bool { self.svm.get_account(&a(&p)).map(|x| x.lamports > 0).unwrap_or(false) }
    fn token_balance(&self, p: Pubkey) -> u64 {
        let acc = self.svm.get_account(&a(&p)).unwrap();
        u64::from_le_bytes(acc.data[64..72].try_into().unwrap()) // the amount field, the same in Token and Token-2022
    }
    fn mint_program(&self, mint: Pubkey) -> Pubkey { pk(&self.svm.get_account(&a(&mint)).expect("mint copied").owner) }
    /// A version-0 transaction with the given lookup tables, checked against the packet limit.
    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair], tables: &[Pubkey]) -> Result<usize, String> {
        let alts: Vec<AddressLookupTableAccount> = tables.iter().map(|t| {
            let data = self.svm.get_account(&a(t)).unwrap().data;
            AddressLookupTableAccount { key: a(t), addresses: data[56..].chunks(32).map(|c| Address::new_from_array(c.try_into().unwrap())).collect() }
        }).collect();
        let msg = v0::Message::try_compile(&signers[0].pubkey(), ixs, &alts, self.svm.latest_blockhash()).map_err(|e| format!("{e:?}"))?;
        let tx = VersionedTransaction::try_new(VersionedMessage::V0(msg), signers).map_err(|e| format!("{e:?}"))?;
        let size = 1 + 64 * tx.signatures.len() + tx.message.serialize().len();
        assert!(size <= PACKET, "the transaction is {size} bytes, over Solana's {PACKET}");
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res.map(|_| size).map_err(|e| format!("{:?} :: {}", e.err, e.meta.logs.join(" | ")))
    }
    /// An address lookup table holding `addresses`, as the trade service will keep for its fills' fixed accounts
    /// (the table's 56-byte header: active, never deactivated, last extended at slot 0, no authority).
    fn local_table(&mut self, addresses: &[Pubkey]) -> Pubkey {
        let table = Pubkey::new_unique();
        let mut data = vec![];
        data.extend_from_slice(&1u32.to_le_bytes()); // a lookup table
        data.extend_from_slice(&u64::MAX.to_le_bytes()); // deactivation slot: never
        data.extend_from_slice(&0u64.to_le_bytes()); // last extended slot
        data.push(0); // last extended slot's start index
        data.push(0); // no authority
        data.extend_from_slice(&[0u8; 32 + 2]);
        assert_eq!(data.len(), 56);
        for k in addresses { data.extend_from_slice(k.as_ref()); }
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        let owner = Pubkey::from_str("AddressLookupTab1e1111111111111111111111111").unwrap();
        self.svm.set_account(a(&table), Account { lamports, data, owner: a(&owner), executable: false, rent_epoch: 0 }).unwrap();
        table
    }
    /// `owner`'s canonical token account for `mint`, created by the executor (as the trade service would).
    fn ata_of(&mut self, owner: Pubkey, mint: Pubkey) -> Pubkey {
        let program = self.mint_program(mint);
        let i = spl_associated_token_account::instruction::create_associated_token_account_idempotent(&key(&self.exec), &owner, &mint, &program);
        let exec = self.exec.insecure_clone();
        self.send(&[ix(i.program_id, i.accounts, i.data)], &[&exec], &[]).unwrap();
        ata(&owner, &mint, &program)
    }
    /// The user's wrapped SOL: a classic-token account holding `amount`, at their canonical address.
    fn user_wsol(&mut self, amount: u64) -> Pubkey {
        let address = ata(&key(&self.user), &WSOL_MINT, &spl_token::ID);
        let rent = self.svm.minimum_balance_for_rent_exemption(spl_token::state::Account::LEN);
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        spl_token::state::Account { mint: WSOL_MINT, owner: key(&self.user), amount, delegate: COption::None, state: spl_token::state::AccountState::Initialized,
            is_native: COption::Some(rent), delegated_amount: 0, close_authority: COption::None }.pack_into_slice(&mut data);
        self.svm.set_account(a(&address), Account { lamports: rent + amount, data, owner: a(&spl_token::ID), executable: false, rent_epoch: 0 }).unwrap();
        address
    }
    fn approve(&mut self, account: Pubkey, mint: Pubkey, amount: u64) {
        let program = self.mint_program(mint);
        let i = spl_token_2022::instruction::approve(&program, &account, &delegate(), &key(&self.user), &[], amount).unwrap();
        let user = self.user.insecure_clone();
        self.send(&[ix(program, i.accounts, i.data)], &[&user], &[]).unwrap();
    }
    fn place(&mut self, nonce: u64, input: Pubkey, output: Pubkey, native: bool, amount_in: u64, min_out: u64) -> Pubkey {
        let user = self.user.insecure_clone();
        let order = Pubkey::find_program_address(&[ORDER_SEED, key(&user).as_ref(), &nonce.to_le_bytes()], &rektbull_orders::ID).0;
        let now = self.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp;
        let p = OrderParams { executor: key(&self.exec), input_mint: input, output_mint: output, output_native: native, amount_in, min_amount_out: min_out, valid_after: 0, valid_until: now + 3600 };
        let metas = rektbull_orders::accounts::PlaceOrder { owner: key(&user), order, system_program: system_program::ID }.to_account_metas(None);
        self.send(&[ix(rektbull_orders::ID, metas, rektbull_orders::instruction::PlaceOrder { nonce, p }.data())], &[&user], &[]).unwrap();
        order
    }
}

/// What a fill needs beyond the exchange's own instruction.
struct Fill {
    order: Pubkey,
    source: Pubkey,
    input_mint: Pubkey,
    transit_in: Pubkey,
    output_mint: Option<Pubkey>,
    transit_out: Option<Pubkey>,
    owner_out: Option<Pubkey>,
    fee_in: Option<Pubkey>,
    amount_in: u64,
}

impl Chain {
    fn fill(&mut self, f: &Fill, venue: Pubkey, venue_data: Vec<u8>, venue_accounts: Vec<AnchorMeta>, tables: &[Pubkey]) -> Result<usize, String> {
        let input_program = self.mint_program(f.input_mint);
        let mut metas = rektbull_orders::accounts::Fill {
            executor: key(&self.exec), order: f.order, owner: key(&self.user), delegate: delegate(), transit: transit(),
            source: f.source, input_mint: f.input_mint, transit_in: f.transit_in, input_token_program: input_program,
            output_mint: f.output_mint, transit_out: f.transit_out, owner_out: f.owner_out,
            output_token_program: f.output_mint.map(|m| self.mint_program(m)).or(f.transit_out.map(|_| spl_token::ID)),
            fee_wallet: FEE_WALLET, fee_in: f.fee_in, fee_out: None, venue, system_program: system_program::ID,
        }
        .to_account_metas(None);
        // The exchange sees transit as its trader; the outer transaction can't mark a program address as a signer.
        metas.extend(venue_accounts.into_iter().map(|m| AnchorMeta { is_signer: false, ..m }));
        let data = rektbull_orders::instruction::Fill { amount_in: f.amount_in, unwrap_in: false, venue_data }.data();
        let exec = self.exec.insecure_clone();
        self.send(&[ix(rektbull_orders::ID, metas, data)], &[&exec], tables)
    }
}

// ── PumpSwap ──

/// PumpSwap's accounts for transit as the trader, from the copied buy (its writable flags as the real trade had
/// them); `sell` drops the two volume accounts (19 and 20), as PumpSwap's sell layout does.
fn pumpswap_accounts(c: &Chain, transit_coin: Pubkey, transit_wsol: Pubkey, sell: bool) -> Vec<AnchorMeta> {
    let ps = &c.v["pumpswap"];
    let (user, user_uva) = (pubkey(&ps["user"]), pubkey(&ps["user_volume_accumulator"]));
    let transit_uva = Pubkey::find_program_address(&[b"user_volume_accumulator", transit().as_ref()], &PUMP_AMM).0;
    let writable: Vec<bool> = ps["writable"].as_array().unwrap().iter().map(|b| b.as_bool().unwrap()).collect();
    let mut out = vec![];
    for (i, k) in ps["accounts"].as_array().unwrap().iter().map(pubkey).enumerate() {
        if sell && (i == 19 || i == 20) { continue; }
        let k = match i { 1 => transit(), 5 => transit_coin, 6 => transit_wsol, _ if k == user => transit(), _ if k == user_uva => transit_uva, _ => k };
        out.push(if writable[i] { w(k) } else { r(k) });
    }
    out
}

#[test]
#[ignore = "needs mainnet copies: python3 -I scripts/venue_fixtures.py"]
fn pumpswap_buy_and_sell_through_the_order_program() {
    let mut c = Chain::new();
    let coin = pubkey(&c.v["pumpswap"]["accounts"][3]);
    let event_authority = pubkey(&c.v["pumpswap"]["accounts"][15]);
    let (user, exec) = (key(&c.user), c.exec.insecure_clone());
    let transit_coin = c.ata_of(transit(), coin);
    let transit_wsol = c.ata_of(transit(), WSOL_MINT);
    let user_coin = c.ata_of(user, coin);
    let fee_wsol = c.ata_of(FEE_WALLET, WSOL_MINT);
    // One-time setup, paid by the executor: PumpSwap's volume account for transit.
    let uva = Pubkey::find_program_address(&[b"user_volume_accumulator", transit().as_ref()], &PUMP_AMM).0;
    let init = ix(PUMP_AMM, vec![AnchorMeta::new(key(&exec), true), r(transit()), w(uva), r(system_program::ID), r(event_authority), r(PUMP_AMM)], disc("init_user_volume_accumulator"));
    c.send(&[init], &[&exec], &[]).expect("PumpSwap's init_user_volume_accumulator for transit");

    // 1. A limit buy paid in wrapped SOL (PumpSwap takes wrapped SOL): the 1% fee in wrapped SOL.
    let user_wsol = c.user_wsol(SOL);
    c.approve(user_wsol, WSOL_MINT, SOL / 10);
    let order = c.place(1, WSOL_MINT, coin, false, SOL / 10, 1);
    let mut data = disc("buy_exact_quote_in");
    data.extend_from_slice(&(SOL / 10 - SOL / 1000 - SOL / 1000).to_le_bytes()); // after the fee, less headroom
    data.extend_from_slice(&1u64.to_le_bytes());
    data.push(0); // track_volume: false
    let f = Fill { order, source: user_wsol, input_mint: WSOL_MINT, transit_in: transit_wsol, output_mint: Some(coin), transit_out: Some(transit_coin), owner_out: Some(user_coin), fee_in: Some(fee_wsol), amount_in: SOL / 10 };
    // RektBull's own lookup table: the accounts every fill on this pool repeats (not the user's or the order's).
    let mut fixed: Vec<Pubkey> = pumpswap_accounts(&c, transit_coin, transit_wsol, false).iter().map(|m| m.pubkey).collect();
    fixed.extend([rektbull_orders::ID, delegate(), transit(), FEE_WALLET, fee_wsol, WSOL_MINT, coin, spl_token::ID, system_program::ID]);
    fixed.sort();
    fixed.dedup();
    let table = c.local_table(&fixed);
    let size = c.fill(&f, PUMP_AMM, data, pumpswap_accounts(&c, transit_coin, transit_wsol, false), &[table]).expect("the buy through PumpSwap");
    let bought = c.token_balance(user_coin);
    println!("PumpSwap buy: {bought} units of {coin} for 0.1 wrapped SOL; transaction {size} bytes");
    assert!(bought > 0, "the coin reached the user");
    assert_eq!(c.token_balance(fee_wsol), SOL / 1000, "1% in wrapped SOL to the fee wallet");
    assert!(c.token_balance(user_wsol) > SOL - SOL / 10, "the unused wrapped SOL came back");
    assert_eq!((c.lamports(transit()), c.token_balance(transit_wsol), c.token_balance(transit_coin)), (0, 0, 0), "transit holds nothing");

    // 2. A stop-loss: sell it all back, delivered as native SOL (PumpSwap pays wrapped SOL; the program unwraps it).
    c.approve(user_coin, coin, bought);
    let order = c.place(2, coin, WSOL_MINT, true, bought, 1);
    let mut data = disc("sell");
    data.extend_from_slice(&bought.to_le_bytes());
    data.extend_from_slice(&1u64.to_le_bytes());
    let f = Fill { order, source: user_coin, input_mint: coin, transit_in: transit_coin, output_mint: None, transit_out: Some(transit_wsol), owner_out: None, fee_in: None, amount_in: bought };
    let (sol0, fee0) = (c.lamports(user), c.lamports(FEE_WALLET));
    let size = c.fill(&f, PUMP_AMM, data, pumpswap_accounts(&c, transit_coin, transit_wsol, true), &[table]).expect("the sale through PumpSwap");
    let (got, fee) = (c.lamports(user) - sol0, c.lamports(FEE_WALLET) - fee0);
    println!("PumpSwap sale: {got} lamports to the user as native SOL (with the order's rent back), {fee} to the fee wallet; transaction {size} bytes");
    assert!(fee > 0 && fee * 99 <= got, "1% of the SOL out to the fee wallet");
    assert_eq!(c.token_balance(user_coin), 0);
    assert!(!c.exists(transit_wsol), "transit's wrapped-SOL account was unwrapped and closed");
    assert_eq!(c.lamports(transit()), 0, "transit holds nothing");
}

// ── Jupiter ──

fn jupiter(c: &Chain, which: &str) -> (Vec<u8>, Vec<AnchorMeta>, Vec<Pubkey>, u64, u64) {
    let j = &c.v[which];
    let s = &j["swap"];
    let data = base64::engine::general_purpose::STANDARD.decode(s["data"].as_str().unwrap()).unwrap();
    let accounts = s["accounts"].as_array().unwrap().iter()
        .map(|m| AnchorMeta { pubkey: pubkey(&m["pubkey"]), is_signer: false, is_writable: m["isWritable"].as_bool().unwrap() }).collect();
    let tables = j["lookup_tables"].as_array().unwrap().iter().map(pubkey).collect();
    let q = &j["quote"];
    (data, accounts, tables, q["inAmount"].as_str().unwrap().parse().unwrap(), q["outAmount"].as_str().unwrap().parse().unwrap())
}

/// The order size whose input after RektBull's 1% fee is exactly `net` (what the Jupiter instruction spends).
fn gross_for(net: u64) -> u64 { (net..net + net / 50 + 2).find(|g| g - g / 100 == net).expect("an order size") }

#[test]
#[ignore = "needs mainnet copies: python3 -I scripts/venue_fixtures.py"]
fn jupiter_routes_through_the_order_program() {
    let mut c = Chain::new();
    let user = key(&c.user);
    let transit_wsol = c.ata_of(transit(), WSOL_MINT);
    let transit_usdc = c.ata_of(transit(), USDC_MINT);
    let user_usdc = c.ata_of(user, USDC_MINT);
    let fee_wsol = c.ata_of(FEE_WALLET, WSOL_MINT);
    let fee_usdc = c.ata_of(FEE_WALLET, USDC_MINT);

    // 1. A limit buy of USDC with wrapped SOL, through Jupiter's real route.
    let (data, accounts, tables, net_in, quoted) = jupiter(&c, "jupiter_buy");
    let amount = gross_for(net_in);
    let user_wsol = c.user_wsol(SOL);
    c.approve(user_wsol, WSOL_MINT, amount);
    // First with a limit above Jupiter's own quote: refused by the order program.
    let greedy = c.place(1, WSOL_MINT, USDC_MINT, false, amount, quoted * 2);
    let f = Fill { order: greedy, source: user_wsol, input_mint: WSOL_MINT, transit_in: transit_wsol, output_mint: Some(USDC_MINT), transit_out: Some(transit_usdc), owner_out: Some(user_usdc), fee_in: Some(fee_wsol), amount_in: amount };
    let err = c.fill(&f, JUPITER_V6, data.clone(), accounts.clone(), &tables).expect_err("a limit the route can't meet");
    assert!(err.contains("BelowLimit"), "refused for the price: {err}");
    // Then at a limit the route meets.
    let order = c.place(2, WSOL_MINT, USDC_MINT, false, amount, quoted * 97 / 100);
    let f = Fill { order, ..f };
    let size = c.fill(&f, JUPITER_V6, data, accounts, &tables).expect("the buy through Jupiter");
    let got = c.token_balance(user_usdc);
    println!("Jupiter buy ({}): {got} USDC units for {amount} lamports of wrapped SOL (quoted {quoted}); transaction {size} bytes", c.v["jupiter_buy"]["route"]);
    assert!(got >= quoted * 97 / 100);
    assert_eq!(c.token_balance(fee_wsol), amount / 100, "1% in wrapped SOL to the fee wallet");
    assert_eq!((c.lamports(transit()), c.token_balance(transit_wsol), c.token_balance(transit_usdc)), (0, 0, 0), "transit holds nothing");

    // 2. Back to native SOL through Jupiter's other route: the fee in USDC, the wrapped SOL unwrapped.
    let (data, accounts, tables, net_in, quoted) = jupiter(&c, "jupiter_sell");
    let amount = gross_for(net_in);
    assert!(amount <= got, "the sale fits in what was bought");
    c.approve(user_usdc, USDC_MINT, amount);
    let order = c.place(3, USDC_MINT, WSOL_MINT, true, amount, quoted * 97 / 100);
    let f = Fill { order, source: user_usdc, input_mint: USDC_MINT, transit_in: transit_usdc, output_mint: None, transit_out: Some(transit_wsol), owner_out: None, fee_in: Some(fee_usdc), amount_in: amount };
    let sol0 = c.lamports(user);
    let size = c.fill(&f, JUPITER_V6, data, accounts, &tables).expect("the sale through Jupiter");
    let got_sol = c.lamports(user) - sol0;
    println!("Jupiter sale ({}): {got_sol} lamports to the user as native SOL (with the order's rent back; quoted {quoted}); transaction {size} bytes", c.v["jupiter_sell"]["route"]);
    assert!(got_sol >= quoted * 97 / 100);
    assert_eq!(c.token_balance(fee_usdc), amount / 100, "1% in USDC to the fee wallet");
    assert!(!c.exists(transit_wsol), "transit's wrapped-SOL account was unwrapped and closed");
    assert_eq!((c.lamports(transit()), c.token_balance(transit_usdc)), (0, 0), "transit holds nothing");
}
