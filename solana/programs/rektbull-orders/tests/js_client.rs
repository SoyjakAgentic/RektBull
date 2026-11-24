//! The order service's own transactions (src/trade/solanaOrderTx.js), built and signed in Node by
//! scripts/js_client_fixture.js and saved in tests/js_client.json, run here against the compiled program
//! (target/deploy/rektbull_orders.so) on LiteSVM, with signatures checked. So the service's instruction layouts,
//! account order, PDAs, approval and fill sizing are the program's, not a copy that could drift: if either side
//! changes, this fails (and test/solanaOrders.test.js fails if the JSON wasn't rebuilt).
//!
//! The stand-in exchange (programs/mock-venue) sits at Jupiter's address and pays wrapped SOL into transit's
//! wrapped-SOL account, as Jupiter does; every key is a test key made from a fixed seed.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::{program_option::COption, program_pack::Pack, system_program};
use anchor_spl::token::spl_token;
use litesvm::LiteSVM;
use rektbull_orders::{JUPITER_V6, WSOL_MINT};
use serde_json::Value;
use solana_account::Account;
use solana_address::Address;
use solana_transaction::versioned::VersionedTransaction;
use std::str::FromStr;

fn a(p: &Pubkey) -> Address { Address::new_from_array(p.to_bytes()) }
fn key(v: &Value) -> Pubkey { Pubkey::from_str(v.as_str().expect("an address")).expect("base58") }
fn num(v: &Value) -> i128 { v.as_str().expect("a number as text").parse().expect("a number") }
fn deploy(name: &str) -> String { format!("{}/../../target/deploy/{name}.so", env!("CARGO_MANIFEST_DIR")) }

struct Chain { svm: LiteSVM }

impl Chain {
    fn new(j: &Value) -> Chain {
        // Signatures are checked (the fixture signs in Node); the blockhash isn't (the fixture's is fixed).
        let mut svm = LiteSVM::new().with_blockhash_check(false);
        svm.add_program_from_file(a(&rektbull_orders::ID), deploy("rektbull_orders")).unwrap();
        svm.add_program_from_file(a(&JUPITER_V6), deploy("mock_venue")).unwrap();
        assert_eq!(key(&j["program"]), rektbull_orders::ID, "the fixture names this program");
        assert_eq!(key(&j["fee_wallet"]), rektbull_orders::FEE_WALLET, "the fixture names the program's fee wallet");
        let mut clock = svm.get_sysvar::<solana_clock::Clock>();
        clock.unix_timestamp = j["now"].as_i64().unwrap();
        svm.set_sysvar(&clock);
        let mut c = Chain { svm };
        let s = &j["setup"];
        for m in s["mints"].as_array().unwrap() { c.mint(key(&m["address"]), m["decimals"].as_u64().unwrap() as u8); }
        for t in s["token_accounts"].as_array().unwrap() { c.token_account(key(&t["address"]), key(&t["mint"]), key(&t["owner"]), num(&t["amount"]) as u64); }
        for l in s["lamports"].as_array().unwrap() {
            c.svm.set_account(a(&key(&l["address"])), Account { lamports: num(&l["lamports"]) as u64, data: vec![], owner: a(&system_program::ID), executable: false, rent_epoch: 0 }).unwrap();
        }
        // The stand-in exchange's vault holds the SOL behind its wrapped SOL.
        c.svm.set_account(a(&key(&j["vault"])), Account { lamports: 1_000_000_000_000, data: vec![], owner: a(&system_program::ID), executable: false, rent_epoch: 0 }).unwrap();
        c
    }
    fn rent(&self, len: usize) -> u64 { self.svm.minimum_balance_for_rent_exemption(len) }
    fn mint(&mut self, address: Pubkey, decimals: u8) {
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        spl_token::state::Mint { mint_authority: COption::None, supply: 0, decimals, is_initialized: true, freeze_authority: COption::None }.pack_into_slice(&mut data);
        let lamports = self.rent(data.len());
        self.svm.set_account(a(&address), Account { lamports, data, owner: a(&spl_token::ID), executable: false, rent_epoch: 0 }).unwrap();
    }
    fn token_account(&mut self, address: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
        let rent = self.rent(spl_token::state::Account::LEN);
        let native = mint == WSOL_MINT;
        let mut data = vec![0u8; spl_token::state::Account::LEN];
        spl_token::state::Account {
            mint, owner, amount, delegate: COption::None, state: spl_token::state::AccountState::Initialized,
            is_native: if native { COption::Some(rent) } else { COption::None }, delegated_amount: 0, close_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        self.svm.set_account(a(&address), Account { lamports: rent + if native { amount } else { 0 }, data, owner: a(&spl_token::ID), executable: false, rent_epoch: 0 }).unwrap();
    }
    fn lamports(&self, p: Pubkey) -> i128 { self.svm.get_balance(&a(&p)).unwrap_or(0) as i128 }
    fn token(&self, p: Pubkey) -> Option<spl_token::state::Account> {
        self.svm.get_account(&a(&p)).filter(|x| x.lamports > 0 && !x.data.is_empty()).map(|x| spl_token::state::Account::unpack(&x.data).unwrap())
    }
    fn exists(&self, p: Pubkey) -> bool { self.svm.get_account(&a(&p)).map(|x| x.lamports > 0).unwrap_or(false) }
    fn order(&self, p: Pubkey) -> Option<rektbull_orders::Order> {
        use anchor_lang::AccountDeserialize;
        self.svm.get_account(&a(&p)).filter(|x| x.lamports > 0).map(|x| rektbull_orders::Order::try_deserialize(&mut x.data.as_slice()).unwrap())
    }
}

#[test]
fn the_order_services_own_transactions_run_against_the_program() {
    let path = format!("{}/tests/js_client.json", env!("CARGO_MANIFEST_DIR"));
    let j: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("tests/js_client.json")).unwrap();
    let mut c = Chain::new(&j);
    let order_rent = c.rent(8 + <rektbull_orders::Order as anchor_lang::Space>::INIT_SPACE) as i128;
    for step in j["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, step["tx"].as_str().unwrap()).unwrap();
        assert!(bytes.len() <= 1232, "{name}: {} bytes, over Solana's packet limit", bytes.len());
        let tx: VersionedTransaction = bincode::deserialize(&bytes).expect("a version-0 transaction");
        let checks = step["checks"].as_array().unwrap();
        let before: Vec<(i128, i128)> = checks.iter().map(|ch| match ch.get("address") {
            Some(addr) => (c.lamports(key(addr)), c.token(key(addr)).map(|t| t.amount as i128).unwrap_or(0)),
            None => (0, 0),
        }).collect();
        let res = c.svm.send_transaction(tx);
        let expect = step["expect"].as_str().unwrap();
        match (&res, expect) {
            (Ok(_), "ok") => {}
            (Err(e), want) if want != "ok" => {
                let logs = e.meta.logs.join(" | ");
                assert!(logs.contains(want) || format!("{:?}", e.err).contains(want), "{name}: expected {want}, got {:?} :: {logs}", e.err);
            }
            (Ok(_), want) => panic!("{name}: expected {want}, but it went through"),
            (Err(e), _) => panic!("{name}: {:?} :: {}", e.err, e.meta.logs.join(" | ")),
        }
        for (ch, (lamports0, token0)) in checks.iter().zip(before) {
            if let Some(o) = ch.get("order") {
                let order = c.order(key(o));
                if let Some(e) = ch.get("exists") { assert_eq!(order.is_some(), e.as_bool().unwrap(), "{name}: order exists?"); }
                if let Some(f) = ch.get("filled_in") { assert_eq!(order.expect("the order").filled_in as i128, num(f), "{name}: filled_in"); }
                continue;
            }
            let addr = key(&ch["address"]);
            if let Some(d) = ch.get("lamports_delta") {
                let want = num(d) + if ch.get("plus_order_rent").and_then(|v| v.as_bool()).unwrap_or(false) { order_rent } else { 0 };
                assert_eq!(c.lamports(addr) - lamports0, want, "{name}: SOL change of {addr}");
            }
            if let Some(l) = ch.get("lamports") { assert_eq!(c.lamports(addr), num(l), "{name}: SOL of {addr}"); }
            if let Some(d) = ch.get("token_delta") { assert_eq!(c.token(addr).map(|t| t.amount as i128).unwrap_or(0) - token0, num(d), "{name}: token change of {addr}"); }
            if let Some(d) = ch.get("delegated") {
                let t = c.token(addr).expect("the token account");
                let delegate = Pubkey::find_program_address(&[rektbull_orders::DELEGATE_SEED], &rektbull_orders::ID).0;
                assert_eq!(t.delegate, COption::Some(delegate), "{name}: approved to the program's delegate");
                assert_eq!(t.delegated_amount as i128, num(d), "{name}: the approved amount");
            }
            if let Some(e) = ch.get("exists") { assert_eq!(c.exists(addr), e.as_bool().unwrap(), "{name}: {addr} exists?"); }
        }
        println!("ok: {name} ({} bytes)", bytes.len());
    }
}
