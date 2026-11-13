//! Break-it tests for the RektBull order program, on a blank Solana chain (LiteSVM) running the compiled
//! program (target/deploy/rektbull_orders.so: run `cargo build-sbf --arch v0` first). Honest fills first,
//! then what a hacked RektBull (the executor) or anyone else might try. The exchange is a stand-in
//! (programs/mock-venue) loaded at Jupiter's address, so it counts as an allowed venue.
//!
//! Anchor 0.32 uses Solana's 2.x types and LiteSVM its 3.x/4.x ones; `a()` and `pk()` convert between them.

use anchor_lang::prelude::{AccountMeta as AnchorMeta, Pubkey};
use anchor_lang::solana_program::{program_option::COption, program_pack::Pack, system_program};
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token;
use litesvm::LiteSVM;
use rektbull_orders::{OrderParams, DELEGATE_SEED, FEE_WALLET, JUPITER_V6, ORDER_SEED, TRANSIT_SEED, USDC_MINT, WSOL_MINT};
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const SOL: u64 = 1_000_000_000;
const MEME: u64 = 1_000_000; // one meme token (6 decimals)
const NOW: i64 = 1_800_000_000;

fn a(p: &Pubkey) -> Address { Address::new_from_array(p.to_bytes()) }
fn pk(x: &Address) -> Pubkey { Pubkey::new_from_array(x.to_bytes()) }
fn key(k: &Keypair) -> Pubkey { pk(&k.pubkey()) }
fn deploy(name: &str) -> String { format!("{}/../../target/deploy/{name}.so", env!("CARGO_MANIFEST_DIR")) }

fn delegate() -> Pubkey { Pubkey::find_program_address(&[DELEGATE_SEED], &rektbull_orders::ID).0 }
fn transit() -> Pubkey { Pubkey::find_program_address(&[TRANSIT_SEED], &rektbull_orders::ID).0 }
fn vault() -> Pubkey { Pubkey::find_program_address(&[b"vault"], &JUPITER_V6).0 }
fn order_pda(owner: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(&[ORDER_SEED, owner.as_ref(), &nonce.to_le_bytes()], &rektbull_orders::ID).0
}
const TOKEN: Pubkey = spl_token::ID;

fn ix(program: Pubkey, metas: Vec<AnchorMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: a(&program),
        accounts: metas.into_iter().map(|m| AccountMeta { pubkey: a(&m.pubkey), is_signer: m.is_signer, is_writable: m.is_writable }).collect(),
        data,
    }
}
fn w(p: Pubkey) -> AnchorMeta { AnchorMeta::new(p, false) }
fn r(p: Pubkey) -> AnchorMeta { AnchorMeta::new_readonly(p, false) }

/// The stand-in exchange's instruction data: [op][a][b].
fn venue_data(op: u8, x: u64, y: u64) -> Vec<u8> {
    let mut d = vec![op];
    d.extend_from_slice(&x.to_le_bytes());
    d.extend_from_slice(&y.to_le_bytes());
    d
}

struct World {
    svm: LiteSVM,
    meme: Pubkey,
    user: Keypair,
    exec: Keypair,
    user_meme: Pubkey,
    user_usdc: Pubkey,
    user_wsol: Pubkey,
    vault_meme: Pubkey,
    vault_usdc: Pubkey,
    transit_meme: Pubkey,
    transit_usdc: Pubkey,
    fee_usdc: Pubkey,
}

/// What a fill sends; `fill()` builds the instruction from it.
#[derive(Clone)]
struct Fill {
    order: Pubkey,
    owner: Pubkey,
    source: Pubkey,
    input_mint: Pubkey,
    transit_in: Pubkey,
    output_mint: Option<Pubkey>,
    transit_out: Option<Pubkey>,
    owner_out: Option<Pubkey>,
    fee_in: Option<Pubkey>,
    fee_wallet: Pubkey,
    delegate: Pubkey,
    venue: Pubkey,
    amount_in: u64,
    unwrap_in: bool,
    venue_data: Vec<u8>,
    venue_accounts: Vec<AnchorMeta>,
}

impl World {
    fn new() -> World {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(a(&rektbull_orders::ID), deploy("rektbull_orders")).unwrap();
        svm.add_program_from_file(a(&JUPITER_V6), deploy("mock_venue")).unwrap();
        let mut clock = svm.get_sysvar::<solana_clock::Clock>();
        clock.unix_timestamp = NOW;
        svm.set_sysvar(&clock);
        let user = Keypair::new();
        let exec = Keypair::new();
        let mut wd = World {
            svm, meme: Pubkey::new_unique(), user, exec,
            user_meme: Pubkey::default(), user_usdc: Pubkey::default(), user_wsol: Pubkey::default(), vault_meme: Pubkey::default(),
            vault_usdc: Pubkey::default(), transit_meme: Pubkey::default(), transit_usdc: Pubkey::default(), fee_usdc: Pubkey::default(),
        };
        let meme = wd.meme;
        wd.mint(meme, 6);
        wd.mint(USDC_MINT, 6);
        wd.mint(WSOL_MINT, 9);
        wd.set_lamports(FEE_WALLET, SOL);
        wd.set_lamports(vault(), 1000 * SOL);
        wd.set_lamports(key(&wd.user), 10 * SOL);
        wd.set_lamports(key(&wd.exec), 10 * SOL);
        let (u, v, t) = (key(&wd.user), vault(), transit());
        wd.user_meme = wd.token_account(meme, u, 1_000_000 * MEME);
        wd.user_usdc = wd.token_account(USDC_MINT, u, 1_000_000_000);
        wd.user_wsol = wd.token_account(WSOL_MINT, u, 2 * SOL);
        wd.vault_meme = wd.token_account(meme, v, 100_000_000 * MEME);
        wd.vault_usdc = wd.token_account(USDC_MINT, v, 1_000_000_000_000);
        wd.transit_meme = wd.token_account(meme, t, 0);
        wd.transit_usdc = wd.token_account(USDC_MINT, t, 0);
        wd.fee_usdc = wd.token_account(USDC_MINT, FEE_WALLET, 0);
        wd
    }

    fn now(&self) -> i64 { self.svm.get_sysvar::<solana_clock::Clock>().unix_timestamp }
    fn warp(&mut self, secs: i64) {
        let mut c = self.svm.get_sysvar::<solana_clock::Clock>();
        c.unix_timestamp += secs;
        self.svm.set_sysvar(&c);
    }
    fn lamports(&self, p: Pubkey) -> u64 { self.svm.get_balance(&a(&p)).unwrap_or(0) }
    fn set_lamports(&mut self, p: Pubkey, lamports: u64) {
        self.svm.set_account(a(&p), Account { lamports, data: vec![], owner: a(&system_program::ID), executable: false, rent_epoch: 0 }).unwrap();
    }
    fn rent(&self, len: usize) -> u64 { self.svm.minimum_balance_for_rent_exemption(len) }
    fn mint(&mut self, address: Pubkey, decimals: u8) {
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        spl_token::state::Mint { mint_authority: COption::None, supply: 0, decimals, is_initialized: true, freeze_authority: COption::None }.pack_into_slice(&mut data);
        let lamports = self.rent(data.len());
        self.svm.set_account(a(&address), Account { lamports, data, owner: a(&TOKEN), executable: false, rent_epoch: 0 }).unwrap();
    }
    /// A token account at a fresh address holding `amount`; wrapped SOL accounts carry the SOL too.
    fn token_account(&mut self, mint: Pubkey, owner: Pubkey, amount: u64) -> Pubkey {
        let address = Pubkey::new_unique();
        self.token_account_at(address, mint, owner, amount);
        address
    }
    fn token_account_at(&mut self, address: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
        let rent = self.rent(spl_token::state::Account::LEN);
        let native = mint == WSOL_MINT;
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        spl_token::state::Account {
            mint, owner, amount, delegate: COption::None, state: spl_token::state::AccountState::Initialized,
            is_native: if native { COption::Some(rent) } else { COption::None }, delegated_amount: 0, close_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        let lamports = rent + if native { amount } else { 0 };
        self.svm.set_account(a(&address), Account { lamports, data, owner: a(&TOKEN), executable: false, rent_epoch: 0 }).unwrap();
    }
    fn balance(&self, p: Pubkey) -> Option<u64> {
        self.svm.get_account(&a(&p)).filter(|acc| !acc.data.is_empty()).map(|acc| spl_token::state::Account::unpack(&acc.data).unwrap().amount)
    }
    fn exists(&self, p: Pubkey) -> bool { self.svm.get_account(&a(&p)).map(|acc| acc.lamports > 0).unwrap_or(false) }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
        let payer = signers[0].pubkey();
        let tx = Transaction::new(signers, Message::new(ixs, Some(&payer)), self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        res.map(|_| ()).map_err(|e| format!("{:?} :: {}", e.err, e.meta.logs.join(" | ")))
    }
    fn approve(&mut self, owner: &Keypair, account: Pubkey, amount: u64) {
        let i = spl_token::instruction::approve(&TOKEN, &account, &delegate(), &key(owner), &[], amount).unwrap();
        self.send(&[ix(TOKEN, i.accounts, i.data)], &[owner]).unwrap();
    }
    fn revoke(&mut self, owner: &Keypair, account: Pubkey) {
        let i = spl_token::instruction::revoke(&TOKEN, &account, &key(owner), &[]).unwrap();
        self.send(&[ix(TOKEN, i.accounts, i.data)], &[owner]).unwrap();
    }
    fn place_by(&mut self, owner: &Keypair, nonce: u64, p: OrderParams) -> Result<Pubkey, String> {
        let order = order_pda(&key(owner), nonce);
        let metas = rektbull_orders::accounts::PlaceOrder { owner: key(owner), order, system_program: system_program::ID }.to_account_metas(None);
        let data = rektbull_orders::instruction::PlaceOrder { nonce, p }.data();
        self.send(&[ix(rektbull_orders::ID, metas, data)], &[owner])?;
        Ok(order)
    }
    fn cancel(&mut self, signer: &Keypair, order: Pubkey) -> Result<(), String> {
        let metas = rektbull_orders::accounts::CancelOrder { owner: key(signer), order }.to_account_metas(None);
        self.send(&[ix(rektbull_orders::ID, metas, rektbull_orders::instruction::CancelOrder {}.data())], &[signer])
    }
    fn order(&self, p: Pubkey) -> Option<rektbull_orders::Order> {
        use anchor_lang::AccountDeserialize;
        self.svm.get_account(&a(&p)).filter(|acc| acc.lamports > 0).map(|acc| rektbull_orders::Order::try_deserialize(&mut acc.data.as_slice()).unwrap())
    }
    fn params(&self, input: Pubkey, output: Pubkey, native: bool, amount_in: u64, min_out: u64) -> OrderParams {
        OrderParams { executor: key(&self.exec), input_mint: input, output_mint: output, output_native: native, amount_in, min_amount_out: min_out, valid_after: 0, valid_until: self.now() + 86_400 }
    }
    fn fill_by(&mut self, executor: &Keypair, f: &Fill) -> Result<(), String> {
        let out = f.output_mint.is_some();
        let mut metas = rektbull_orders::accounts::Fill {
            executor: key(executor), order: f.order, owner: f.owner, delegate: f.delegate, transit: transit(),
            source: f.source, input_mint: f.input_mint, transit_in: f.transit_in, input_token_program: TOKEN,
            output_mint: f.output_mint, transit_out: f.transit_out, owner_out: f.owner_out, output_token_program: if out || f.transit_out.is_some() { Some(TOKEN) } else { None },
            fee_wallet: f.fee_wallet, fee_in: f.fee_in, fee_out: None, venue: f.venue, system_program: system_program::ID,
        }
        .to_account_metas(None);
        metas.extend(f.venue_accounts.iter().cloned());
        let data = rektbull_orders::instruction::Fill { amount_in: f.amount_in, unwrap_in: f.unwrap_in, venue_data: f.venue_data.clone() }.data();
        self.send(&[ix(rektbull_orders::ID, metas, data)], &[executor])
    }
    fn fill(&mut self, f: &Fill) -> Result<(), String> {
        let exec = self.exec.insecure_clone();
        self.fill_by(&exec, f)
    }

    // ── The usual orders ──
    /// A sell order: 100,000 meme tokens for at least `min_out` SOL.
    fn sell_order(&mut self, nonce: u64, min_out: u64) -> Pubkey {
        let p = self.params(self.meme, WSOL_MINT, true, 100_000 * MEME, min_out);
        let user = self.user.insecure_clone();
        let order = self.place_by(&user, nonce, p).unwrap();
        self.approve(&user, self.user_meme, 100_000 * MEME);
        order
    }
    /// A sale of meme tokens for SOL: the exchange pays `sol_out` to `to` (transit, honestly).
    fn sale(&self, order: Pubkey, amount_in: u64, sol_out: u64, to: Pubkey) -> Fill {
        Fill {
            order, owner: key(&self.user), source: self.user_meme, input_mint: self.meme, transit_in: self.transit_meme,
            output_mint: None, transit_out: None, owner_out: None, fee_in: None, fee_wallet: FEE_WALLET, delegate: delegate(), venue: JUPITER_V6,
            amount_in, unwrap_in: false, venue_data: venue_data(2, amount_in, sol_out),
            venue_accounts: vec![w(transit()), w(self.transit_meme), r(self.meme), w(self.vault_meme), w(vault()), w(to), r(TOKEN), r(system_program::ID)],
        }
    }
    /// A buy of meme tokens with USDC: the exchange takes `usdc_in` and pays `meme_out` to transit.
    fn usdc_buy(&mut self, nonce: u64) -> (Pubkey, Fill) {
        let p = self.params(USDC_MINT, self.meme, false, 100_000_000, 500 * MEME);
        let user = self.user.insecure_clone();
        let order = self.place_by(&user, nonce, p).unwrap();
        self.approve(&user, self.user_usdc, 100_000_000);
        let f = Fill {
            order, owner: key(&self.user), source: self.user_usdc, input_mint: USDC_MINT, transit_in: self.transit_usdc,
            output_mint: Some(self.meme), transit_out: Some(self.transit_meme), owner_out: Some(self.user_meme), fee_in: Some(self.fee_usdc),
            fee_wallet: FEE_WALLET, delegate: delegate(), venue: JUPITER_V6, amount_in: 100_000_000, unwrap_in: false,
            venue_data: venue_data(0, 99_000_000, 600 * MEME),
            venue_accounts: vec![w(transit()), w(self.transit_usdc), r(USDC_MINT), w(self.vault_usdc), w(self.vault_meme), r(self.meme), w(self.transit_meme), r(vault()), r(TOKEN), r(TOKEN)],
        };
        (order, f)
    }
    fn order_rent(&self) -> u64 { self.rent(8 + rektbull_orders::Order::INIT_SPACE) }
}

fn fails(res: Result<(), String>, what: &str) {
    match res {
        Ok(()) => panic!("expected a failure ({what}), but it went through"),
        Err(e) => assert!(what.split('|').any(|w| e.contains(w)), "expected {what}, got: {e}"),
    }
}

use anchor_lang::Space;

#[test]
fn honest_sale_for_sol() {
    let mut wd = World::new();
    let order = wd.sell_order(1, 99 * SOL / 100);
    let (user0, fee0) = (wd.lamports(key(&wd.user)), wd.lamports(FEE_WALLET));
    let f = wd.sale(order, 100_000 * MEME, SOL, transit());
    wd.fill(&f).unwrap();
    assert_eq!(wd.lamports(FEE_WALLET) - fee0, SOL / 100, "the fee: 1% of the SOL out");
    assert_eq!(wd.lamports(key(&wd.user)) - user0, 99 * SOL / 100 + wd.order_rent(), "99% to the user, and the order's rent back");
    assert_eq!(wd.balance(wd.user_meme), Some(900_000 * MEME));
    assert!(wd.order(order).is_none(), "a fully filled order is closed");
    assert_eq!(wd.lamports(transit()), 0, "transit holds nothing");
    assert_eq!(wd.balance(wd.transit_meme), Some(0));
}

/// A sale through an exchange that pays wrapped SOL (as PumpSwap and Jupiter do), delivered as native SOL.
fn wrapped_sol_sale(wd: &mut World, order: Pubkey, sol_out: u64) -> (Fill, Pubkey) {
    let vault_wsol = wd.token_account(WSOL_MINT, vault(), 10 * SOL);
    let transit_wsol = wd.token_account(WSOL_MINT, transit(), 0); // opened by the executor; its rent comes back to them
    let mut f = wd.sale(order, 100_000 * MEME, 0, transit());
    f.transit_out = Some(transit_wsol);
    f.venue_data = venue_data(0, 100_000 * MEME, sol_out);
    f.venue_accounts = vec![w(transit()), w(wd.transit_meme), r(wd.meme), w(wd.vault_meme), w(vault_wsol), r(WSOL_MINT), w(transit_wsol), r(vault()), r(TOKEN), r(TOKEN)];
    (f, transit_wsol)
}

#[test]
fn sale_paid_in_wrapped_sol_delivered_as_sol() {
    let mut wd = World::new();
    let order = wd.sell_order(1, 99 * SOL / 100);
    let (f, transit_wsol) = wrapped_sol_sale(&mut wd, order, SOL);
    let (user0, fee0, exec0) = (wd.lamports(key(&wd.user)), wd.lamports(FEE_WALLET), wd.lamports(key(&wd.exec)));
    wd.fill(&f).unwrap();
    assert_eq!(wd.lamports(FEE_WALLET) - fee0, SOL / 100, "the fee: 1% of the SOL out, as SOL");
    assert_eq!(wd.lamports(key(&wd.user)) - user0, 99 * SOL / 100 + wd.order_rent(), "99% to the user as native SOL, and the order's rent");
    let account_rent = wd.rent(spl_token::state::Account::LEN);
    assert_eq!(wd.lamports(key(&wd.exec)), exec0 + account_rent - 5000, "the executor got the wrapped-SOL account's rent back");
    assert!(!wd.exists(transit_wsol), "transit's wrapped-SOL account was closed");
    assert_eq!(wd.lamports(transit()), 0);
}

#[test]
fn unwrapping_the_output_needs_transits_own_wrapped_sol_account() {
    let mut wd = World::new();
    let order = wd.sell_order(1, 99 * SOL / 100);
    let (mut f, _) = wrapped_sol_sale(&mut wd, order, SOL);
    f.transit_out = Some(wd.transit_meme); // not wrapped SOL
    fails(wd.fill(&f), "BadFill");
    f.transit_out = Some(wd.token_account(WSOL_MINT, key(&wd.exec), 0)); // not transit's
    fails(wd.fill(&f), "BadFill");
    f.transit_out = None; // the wrapped SOL stays in transit's account: nothing reached the user
    f.owner_out = None;
    fails(wd.fill(&f), "BadFill|BelowLimit|AccountNotInitialized|missing");
}

#[test]
fn honest_buy_paid_in_wrapped_sol_sent_as_sol() {
    let mut wd = World::new();
    let user = wd.user.insecure_clone();
    let p = wd.params(WSOL_MINT, wd.meme, false, SOL, 1000 * MEME);
    let order = wd.place_by(&user, 2, p).unwrap();
    wd.approve(&user, wd.user_wsol, SOL);
    let transit_wsol = wd.token_account(WSOL_MINT, transit(), 0); // opened by the executor; its rent comes back to them
    let (user0, fee0, exec0) = (wd.lamports(key(&user)), wd.lamports(FEE_WALLET), wd.lamports(key(&wd.exec)));
    let f = Fill {
        order, owner: key(&user), source: wd.user_wsol, input_mint: WSOL_MINT, transit_in: transit_wsol,
        output_mint: Some(wd.meme), transit_out: Some(wd.transit_meme), owner_out: Some(wd.user_meme), fee_in: None,
        fee_wallet: FEE_WALLET, delegate: delegate(), venue: JUPITER_V6, amount_in: SOL, unwrap_in: true,
        venue_data: venue_data(1, 98 * SOL / 100, 1500 * MEME), // spends 0.98 of the 0.99 SOL left after the fee
        venue_accounts: vec![w(transit()), w(vault()), w(wd.vault_meme), r(wd.meme), w(wd.transit_meme), r(TOKEN), r(system_program::ID)],
    };
    wd.fill(&f).unwrap();
    assert_eq!(wd.lamports(FEE_WALLET) - fee0, SOL / 100, "the fee: 1% of the SOL in, as SOL");
    assert_eq!(wd.balance(wd.user_meme), Some(1_000_000 * MEME + 1500 * MEME), "the tokens reached the user");
    assert_eq!(wd.lamports(key(&user)) - user0, SOL / 100 + wd.order_rent(), "the unused 0.01 SOL came back as SOL, with the order's rent");
    assert_eq!(wd.balance(wd.user_wsol), Some(SOL));
    let account_rent = wd.rent(spl_token::state::Account::LEN);
    assert_eq!(wd.lamports(key(&wd.exec)), exec0 + account_rent - 5000, "the executor got the wrapped-SOL account's rent back (less the 5,000-lamport transaction fee)");
    assert!(!wd.exists(transit_wsol), "transit's wrapped-SOL account was closed");
    assert_eq!(wd.lamports(transit()), 0);
}

#[test]
fn buy_paid_in_usdc_fee_in_usdc() {
    let mut wd = World::new();
    let (_, f) = wd.usdc_buy(3);
    wd.fill(&f).unwrap();
    assert_eq!(wd.balance(wd.fee_usdc), Some(1_000_000), "1 USDC: 1% of 100, never in the meme coin");
    assert_eq!(wd.balance(wd.user_meme), Some(1_000_000 * MEME + 600 * MEME));
    assert_eq!(wd.balance(wd.transit_usdc), Some(0));
    assert_eq!(wd.balance(wd.transit_meme), Some(0));
}

#[test]
fn unused_token_input_goes_back_to_the_user() {
    let mut wd = World::new();
    let (_, mut f) = wd.usdc_buy(3);
    f.venue_data = venue_data(0, 50_000_000, 600 * MEME); // the exchange takes only 50 of the 99 USDC
    wd.fill(&f).unwrap();
    assert_eq!(wd.balance(wd.user_usdc), Some(1_000_000_000 - 100_000_000 + 49_000_000));
    assert_eq!(wd.balance(wd.transit_usdc), Some(0));
}

#[test]
fn below_the_users_price_is_refused() {
    let mut wd = World::new();
    let order = wd.sell_order(1, 99 * SOL / 100);
    let f = wd.sale(order, 100_000 * MEME, 99 * SOL / 100, transit()); // 0.99 less 1% = 0.9801 < 0.99
    fails(wd.fill(&f), "BelowLimit");
}

#[test]
fn an_exchange_paying_someone_else_is_refused() {
    let mut wd = World::new();
    let order = wd.sell_order(1, 99 * SOL / 100);
    let thief = Pubkey::new_unique();
    wd.set_lamports(thief, SOL);
    let f = wd.sale(order, 100_000 * MEME, 2 * SOL, thief);
    fails(wd.fill(&f), "BelowLimit");
}

#[test]
fn partial_fills_each_pro_rata_never_more_than_the_order() {
    let mut wd = World::new();
    let order = wd.sell_order(1, 99 * SOL / 100);
    wd.approve(&wd.user.insecure_clone(), wd.user_meme, 200_000 * MEME); // more than the order: the order still caps it
    wd.fill(&wd.sale(order, 30_000 * MEME, 30 * SOL / 100, transit())).unwrap();
    assert_eq!(wd.order(order).unwrap().filled_in, 30_000 * MEME);
    fails(wd.fill(&wd.sale(order, 80_000 * MEME, SOL, transit())), "OverSize");
    fails(wd.fill(&wd.sale(order, 70_000 * MEME, 69 * SOL / 100, transit())), "BelowLimit"); // needs 0.693 after the fee
    wd.fill(&wd.sale(order, 70_000 * MEME, 70 * SOL / 100, transit())).unwrap();
    assert!(wd.order(order).is_none());
    assert_eq!(wd.balance(wd.user_meme), Some(900_000 * MEME), "exactly the order's size was sold");
}

#[test]
fn only_the_named_executor_can_fill() {
    let mut wd = World::new();
    let order = wd.sell_order(1, 99 * SOL / 100);
    let other = Keypair::new();
    wd.set_lamports(key(&other), SOL);
    let f = wd.sale(order, 100_000 * MEME, SOL, transit());
    fails(wd.fill_by(&other, &f), "NotExecutor");
}

#[test]
fn not_before_the_window_not_after_it() {
    let mut wd = World::new();
    let user = wd.user.insecure_clone();
    let mut p = wd.params(wd.meme, WSOL_MINT, true, 100_000 * MEME, 99 * SOL / 100);
    p.valid_after = wd.now() + 3600;
    p.valid_until = wd.now() + 7200;
    let order = wd.place_by(&user, 1, p).unwrap();
    wd.approve(&user, wd.user_meme, 100_000 * MEME);
    fails(wd.fill(&wd.sale(order, 100_000 * MEME, SOL, transit())), "TooEarly");
    wd.warp(7201);
    fails(wd.fill(&wd.sale(order, 100_000 * MEME, SOL, transit())), "Expired");
}

#[test]
fn the_user_cancels_nobody_else_can() {
    let mut wd = World::new();
    let order = wd.sell_order(1, 99 * SOL / 100);
    let exec = wd.exec.insecure_clone();
    fails(wd.cancel(&exec, order), "NotOwner");
    let before = wd.lamports(key(&wd.user));
    wd.cancel(&wd.user.insecure_clone(), order).unwrap();
    assert!(wd.order(order).is_none());
    assert_eq!(wd.lamports(key(&wd.user)), before + wd.order_rent() - 5000, "the order's rent came back (less the transaction fee)");
    fails(wd.fill(&wd.sale(order, 100_000 * MEME, SOL, transit())), "AccountNotInitialized");
}

#[test]
fn revoking_the_delegate_stops_every_sell_order() {
    let mut wd = World::new();
    let order = wd.sell_order(1, 99 * SOL / 100);
    let user = wd.user.insecure_clone();
    wd.revoke(&user, wd.user_meme);
    fails(wd.fill(&wd.sale(order, 100_000 * MEME, SOL, transit())), "owner does not match|OwnerMismatch|custom program error: 0x4");
}

#[test]
fn an_exchange_not_on_the_list_is_refused() {
    let mut wd = World::new();
    let other = Pubkey::new_unique();
    wd.svm.add_program_from_file(a(&other), deploy("mock_venue")).unwrap();
    let order = wd.sell_order(1, 99 * SOL / 100);
    let mut f = wd.sale(order, 100_000 * MEME, SOL, transit());
    f.venue = other;
    fails(wd.fill(&f), "VenueNotAllowed");
}

#[test]
fn bad_orders_are_refused() {
    let mut wd = World::new();
    let user = wd.user.insecure_clone();
    let p = wd.params(wd.meme, WSOL_MINT, true, 100_000 * MEME, 0);
    fails(wd.place_by(&user, 1, p).map(|_| ()), "NoMinimum"); // it could be filled at any price
    let p = wd.params(WSOL_MINT, WSOL_MINT, true, SOL, 1);
    fails(wd.place_by(&user, 2, p).map(|_| ()), "BadOrder");
    let mut p = wd.params(wd.meme, WSOL_MINT, true, 100_000 * MEME, 1);
    p.valid_until = wd.now() - 1;
    fails(wd.place_by(&user, 3, p).map(|_| ()), "BadOrder");
}

#[test]
fn nobody_can_place_an_order_for_someone_else() {
    let mut wd = World::new();
    let attacker = Keypair::new();
    wd.set_lamports(key(&attacker), SOL);
    // An order account at the victim's address, created by the attacker: the program derives it from the signer.
    let p = wd.params(wd.meme, WSOL_MINT, true, 100_000 * MEME, 1);
    let order = order_pda(&key(&wd.user), 7);
    let mut metas = rektbull_orders::accounts::PlaceOrder { owner: key(&attacker), order, system_program: system_program::ID }.to_account_metas(None);
    metas[1].pubkey = order;
    let data = rektbull_orders::instruction::PlaceOrder { nonce: 7, p }.data();
    fails(wd.send(&[ix(rektbull_orders::ID, metas, data)], &[&attacker]), "ConstraintSeeds");
}

#[test]
fn an_order_only_takes_input_from_its_own_owner() {
    let mut wd = World::new();
    // The victim (the user) approved the delegate; the attacker places an order of their own.
    let attacker = Keypair::new();
    wd.set_lamports(key(&attacker), SOL);
    let p = wd.params(wd.meme, WSOL_MINT, true, 100_000 * MEME, 1);
    let attacker_order = wd.place_by(&attacker, 1, p).unwrap();
    wd.approve(&wd.user.insecure_clone(), wd.user_meme, 100_000 * MEME);
    let mut f = wd.sale(attacker_order, 100_000 * MEME, SOL, transit());
    f.owner = key(&attacker); // the victim's tokens as the source
    fails(wd.fill(&f), "ConstraintTokenOwner");
    f.owner = key(&wd.user); // or the victim named as the owner
    fails(wd.fill(&f), "BadFill|ConstraintHasOne");
    assert_eq!(wd.balance(wd.user_meme), Some(1_000_000 * MEME));
}

#[test]
fn the_exchange_cant_use_the_programs_signatures_on_approved_tokens() {
    let mut wd = World::new();
    let victim = Keypair::new();
    wd.set_lamports(key(&victim), SOL);
    let victim_meme = wd.token_account(wd.meme, key(&victim), 500_000 * MEME);
    wd.approve(&victim, victim_meme, 500_000 * MEME); // the victim's own standing approval to the delegate
    let order = wd.sell_order(1, 99 * SOL / 100);
    let loot = wd.token_account(wd.meme, key(&wd.exec), 0);
    let steal = |wd: &World, authority: Pubkey| {
        let mut f = wd.sale(order, 100_000 * MEME, SOL, transit());
        f.venue_data = venue_data(3, 500_000 * MEME, 0);
        f.venue_accounts = vec![r(authority), w(victim_meme), r(wd.meme), w(loot), r(TOKEN)];
        f
    };
    // The delegate never reaches a venue at all.
    fails(wd.fill(&steal(&wd, delegate())), "BadFill");
    // Transit signs the venue call, but nobody approved transit.
    fails(wd.fill(&steal(&wd, transit())), "owner does not match|custom program error: 0x4");
    assert_eq!(wd.balance(victim_meme), Some(500_000 * MEME));
    assert_eq!(wd.balance(loot), Some(0));
}

#[test]
fn the_exchange_cant_take_sol_from_the_owner() {
    let mut wd = World::new();
    let order = wd.sell_order(1, 99 * SOL / 100);
    let mut f = wd.sale(order, 100_000 * MEME, SOL, transit());
    f.venue_data = venue_data(4, SOL, 0);
    f.venue_accounts = vec![w(key(&wd.user)), w(key(&wd.exec)), r(system_program::ID)];
    fails(wd.fill(&f), "signer privilege escalated|MissingRequiredSignature|missing required signature");
}

#[test]
fn the_fee_only_goes_to_the_fee_wallet() {
    let mut wd = World::new();
    let (_, f) = wd.usdc_buy(3);
    let thief_usdc = wd.token_account(USDC_MINT, key(&wd.exec), 0);
    let mut bad = f.clone();
    bad.fee_in = Some(thief_usdc);
    fails(wd.fill(&bad), "BadFill");
    let mut bad = f.clone();
    bad.fee_wallet = key(&wd.exec);
    fails(wd.fill(&bad), "BadFill");
}

#[test]
fn the_output_only_goes_to_the_owner() {
    let mut wd = World::new();
    let (_, mut f) = wd.usdc_buy(3);
    f.owner_out = Some(wd.token_account(wd.meme, key(&wd.exec), 0));
    fails(wd.fill(&f), "BadFill");
}

#[test]
fn funds_sent_to_transit_cant_jam_fills() {
    let mut wd = World::new();
    wd.set_lamports(transit(), SOL / 2);
    let (t_meme, meme) = (wd.transit_meme, wd.meme);
    wd.token_account_at(t_meme, meme, transit(), 5 * MEME);
    let order = wd.sell_order(1, 99 * SOL / 100);
    wd.fill(&wd.sale(order, 100_000 * MEME, SOL, transit())).unwrap();
    assert_eq!(wd.lamports(transit()), 0);
    assert_eq!(wd.balance(wd.transit_meme), Some(0));
}

#[test]
fn unwrapping_needs_wrapped_sol_in() {
    let mut wd = World::new();
    let order = wd.sell_order(1, 99 * SOL / 100);
    let mut f = wd.sale(order, 100_000 * MEME, SOL, transit());
    f.unwrap_in = true;
    fails(wd.fill(&f), "BadFill");
}

// ── Random sequences (the Solana counterpart of the EVM routers' invariant fuzzing) ──

/// xorshift64*: a small fixed-seed generator, so a failing sequence can be replayed from its seed.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 { self.next() % n.max(1) }
}

/// 64 random sequences of 40 steps each: two users placing sell orders (some approved for less than the
/// order), the executor filling at random prices and sizes through an exchange that sometimes pays someone
/// else, an attacker trying to fill, cancels by anyone, revokes, time passing, and stray SOL and tokens sent to
/// transit. After every step:
/// - transit holds nothing;
/// - no order is filled past its size, and no user lost more tokens than their successful fills sold;
/// - every successful fill paid its owner at least their price, pro rata, and the fee was at most 1%;
/// - the attacker never filled anything, and a bystander who approved the delegate lost nothing.
#[test]
fn random_sequences_keep_the_invariants() {
    let mut fills_ok = 0u32;
    let mut refused = 0u32;
    for seed in 1..=64u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut wd = World::new();
        let bob = Keypair::new();
        wd.set_lamports(key(&bob), 10 * SOL);
        let bob_meme = wd.token_account(wd.meme, key(&bob), 1_000_000 * MEME);
        let bystander = Keypair::new();
        wd.set_lamports(key(&bystander), SOL);
        let by_meme = wd.token_account(wd.meme, key(&bystander), 500_000 * MEME);
        wd.approve(&bystander, by_meme, 500_000 * MEME);
        let attacker = Keypair::new();
        wd.set_lamports(key(&attacker), 10 * SOL);
        let users = [(wd.user.insecure_clone(), wd.user_meme), (bob.insecure_clone(), bob_meme)];
        let mut sold = [0u64; 2];
        let mut orders: Vec<(usize, Pubkey, u64, u64)> = vec![]; // (user, order, amount_in, min_out)
        let mut nonce = 0u64;
        for _step in 0..40 {
            match rng.below(9) {
                0 | 1 => {
                    let u = rng.below(2) as usize;
                    let amount = (1 + rng.below(200_000)) * MEME;
                    let min_out = 1 + amount / MEME * (SOL / 100_000) * (50 + rng.below(100)) / 100; // 0.5–1.5 SOL per 100k
                    nonce += 1;
                    let p = OrderParams { executor: key(&wd.exec), input_mint: wd.meme, output_mint: WSOL_MINT, output_native: true, amount_in: amount, min_amount_out: min_out, valid_after: 0, valid_until: wd.now() + 1 + rng.below(3 * 86_400) as i64 };
                    let order = wd.place_by(&users[u].0, nonce, p).unwrap();
                    let approve = if rng.below(4) == 0 { amount / 2 } else { amount * 2 };
                    wd.approve(&users[u].0, users[u].1, approve);
                    orders.push((u, order, amount, min_out));
                }
                2..=5 if !orders.is_empty() => {
                    let (u, order, total, min_out) = orders[rng.below(orders.len() as u64) as usize];
                    let left = wd.order(order).map(|o| o.amount_in - o.filled_in).unwrap_or(1);
                    let part = 1 + rng.below(left + left / 4); // sometimes more than is left
                    let pay = part / MEME * (SOL / 100_000) * (30 + rng.below(170)) / 100; // 0.3–2 SOL per 100k
                    let attack = rng.below(6) == 0;
                    let to = if rng.below(5) == 0 { key(&attacker) } else { transit() };
                    let mut f = wd.sale(order, part, pay, to);
                    f.owner = key(&users[u].0);
                    f.source = users[u].1;
                    let (owner0, fee0) = (wd.lamports(key(&users[u].0)), wd.lamports(FEE_WALLET));
                    let res = if attack { wd.fill_by(&attacker.insecure_clone(), &f) } else { wd.fill(&f) };
                    match res {
                        Ok(()) => {
                            assert!(!attack, "seed {seed}: the attacker filled an order");
                            fills_ok += 1;
                            sold[u] += part;
                            let closed = wd.order(order).is_none();
                            let gain = wd.lamports(key(&users[u].0)) - owner0 - if closed { wd.order_rent() } else { 0 };
                            let fee = wd.lamports(FEE_WALLET) - fee0;
                            let minimum = ((min_out as u128 * part as u128).div_ceil(total as u128)) as u64;
                            assert!(gain >= minimum, "seed {seed}: the owner got {gain}, under their price {minimum}");
                            assert!(fee as u128 * 100 <= (gain + fee) as u128, "seed {seed}: fee {fee} over 1% of {}", gain + fee);
                        }
                        Err(_) => refused += 1,
                    }
                }
                6 if !orders.is_empty() => {
                    let (u, order, _, _) = orders[rng.below(orders.len() as u64) as usize];
                    let who = if rng.below(2) == 0 { users[u].0.insecure_clone() } else { attacker.insecure_clone() };
                    let was = wd.order(order).is_some();
                    let ok = wd.cancel(&who, order).is_ok();
                    assert!(!ok || (was && who.pubkey() == users[u].0.pubkey()), "seed {seed}: someone else cancelled an order");
                }
                7 => {
                    if rng.below(2) == 0 {
                        let u = rng.below(2) as usize;
                        wd.revoke(&users[u].0, users[u].1);
                    } else {
                        wd.warp(rng.below(2 * 86_400) as i64);
                    }
                }
                _ => {
                    // Stray funds sent to transit.
                    let lamports = wd.lamports(transit()) + rng.below(SOL / 10);
                    wd.set_lamports(transit(), lamports);
                    let (t_meme, meme) = (wd.transit_meme, wd.meme);
                    let extra = wd.balance(t_meme).unwrap_or(0) + rng.below(10 * MEME);
                    wd.token_account_at(t_meme, meme, transit(), extra);
                }
            }
            // Invariants after every step (stray funds may sit in transit until the next fill sweeps them).
            for (i, (_, acc)) in users.iter().enumerate() {
                // (At least: stray tokens found in transit are swept to the account a fill's input came from.)
                assert!(wd.balance(*acc).unwrap() >= 1_000_000 * MEME - sold[i], "seed {seed}: user {i} lost tokens no fill sold");
            }
            for (_, order, total, _) in &orders {
                if let Some(o) = wd.order(*order) { assert!(o.filled_in <= *total, "seed {seed}: overfilled"); }
            }
            assert_eq!(wd.balance(by_meme), Some(500_000 * MEME), "seed {seed}: the bystander lost tokens");
        }
        // A last honest fill sweeps any stray funds: transit ends empty.
        let order = wd.sell_order(10_000, 1);
        wd.fill(&wd.sale(order, 100_000 * MEME, SOL, transit())).unwrap();
        assert_eq!(wd.lamports(transit()), 0, "seed {seed}: transit kept SOL");
        assert_eq!(wd.balance(wd.transit_meme), Some(0), "seed {seed}: transit kept tokens");
    }
    println!("{fills_ok} fills went through, {refused} were refused");
    assert!(fills_ok >= 150, "the sequences really fill orders ({fills_ok})");
}
