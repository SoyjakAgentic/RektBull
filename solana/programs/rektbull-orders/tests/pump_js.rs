//! The order service's direct pump.fun curve fills (src/trade/pumpCurve.js, solanaOrderTx.js), built and signed in
//! Node by scripts/pump_js_fixture.js, run here against pump.fun's real program and one live curve copied from
//! mainnet (scripts/pump_fixtures.py). Ignored by default because it needs those copies:
//!
//!   python3 -I scripts/pump_fixtures.py && node scripts/pump_js_fixture.js
//!   cargo build-sbf --arch v0 && cargo test -p rektbull-orders --test pump_js -- --ignored
//!
//! It checks that the accounts and data the service builds for pump.fun's `buy_exact_quote_in_v3` and `sell_v3`,
//! with transit as the trader, are the ones pump.fun accepts: a limit buy filled straight on the curve (the coins to
//! the user, 1% of the SOL to the fee wallet), a stop-loss filled straight on the curve (SOL to the user, 1% to the
//! fee wallet), and a floor the curve can't meet, refused. Transit holds nothing after each.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::{program_option::COption, program_pack::Pack, system_program};
use anchor_spl::token::spl_token;
use base64::Engine;
use litesvm::LiteSVM;
use rektbull_orders::{FEE_WALLET, PUMP_FUN, WSOL_MINT};
use serde_json::Value;
use solana_account::Account;
use solana_address::Address;
use solana_transaction::versioned::VersionedTransaction;
use std::str::FromStr;

const SOL: u64 = 1_000_000_000;
const FEE_PROGRAM: &str = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";

fn a(p: &Pubkey) -> Address { Address::new_from_array(p.to_bytes()) }
fn key(v: &Value) -> Pubkey { Pubkey::from_str(v.as_str().unwrap()).unwrap() }
fn root() -> String { format!("{}/../..", env!("CARGO_MANIFEST_DIR")) }
fn fixtures() -> String { format!("{}/fixtures/pump", root()) }

#[test]
#[ignore = "needs mainnet copies: python3 -I scripts/pump_fixtures.py && node scripts/pump_js_fixture.js"]
fn the_order_services_direct_curve_fills_against_pump_funs_real_program() {
    let curves: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/curves.json", fixtures())).expect("run scripts/pump_fixtures.py first")).unwrap();
    let c = curves["v3"].clone();
    let j: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/js_direct.json", fixtures())).expect("run scripts/pump_js_fixture.js first")).unwrap();
    let mut svm = LiteSVM::new().with_blockhash_check(false);
    svm.add_program_from_file(a(&rektbull_orders::ID), format!("{}/target/deploy/rektbull_orders.so", root())).unwrap();
    svm.add_program_from_file(a(&PUMP_FUN), format!("{}/pump.so", fixtures())).unwrap();
    svm.add_program_from_file(a(&Pubkey::from_str(FEE_PROGRAM).unwrap()), format!("{}/pump_fees.so", fixtures())).unwrap();
    for name in ["global", "base_mint", "bonding_curve", "associated_base_bonding_curve", "fee_config", "buyback_fee_recipient", "event_authority"] {
        let Ok(text) = std::fs::read_to_string(format!("{}/v3_{name}.json", fixtures())) else { continue };
        let acc: Value = serde_json::from_str(&text).unwrap();
        let data = base64::engine::general_purpose::STANDARD.decode(acc["data"].as_str().unwrap()).unwrap();
        svm.set_account(a(&key(&acc["address"])), Account { lamports: acc["lamports"].as_u64().unwrap(), data, owner: a(&key(&acc["owner"])), executable: false, rent_epoch: 0 }).unwrap();
    }
    let mut clock = svm.get_sysvar::<solana_clock::Clock>();
    clock.unix_timestamp = c["block_time"].as_i64().unwrap();
    clock.slot = c["slot"].as_u64().unwrap();
    svm.set_sysvar(&clock);
    let mut data = vec![0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint { mint_authority: COption::None, supply: 0, decimals: 9, is_initialized: true, freeze_authority: COption::None }.pack_into_slice(&mut data);
    svm.set_account(a(&WSOL_MINT), Account { lamports: 1_461_600, data, owner: a(&spl_token::ID), executable: false, rent_epoch: 0 }).unwrap();
    let (user, exec, transit, user_coin) = (key(&j["user"]), key(&j["executor"]), key(&j["transit"]), key(&j["user_coin"]));
    for (who, lamports) in [(user, 10 * SOL), (exec, 10 * SOL), (FEE_WALLET, SOL)] {
        svm.set_account(a(&who), Account { lamports, data: vec![], owner: a(&system_program::ID), executable: false, rent_epoch: 0 }).unwrap();
    }
    let lamports = |svm: &LiteSVM, p: Pubkey| svm.get_balance(&a(&p)).unwrap_or(0);
    let coins = |svm: &LiteSVM, p: Pubkey| match svm.get_account(&a(&p)) { Some(x) if x.data.len() >= 72 => u64::from_le_bytes(x.data[64..72].try_into().unwrap()), _ => 0 };

    for step in j["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(step["tx"].as_str().unwrap()).unwrap();
        assert!(bytes.len() <= 1232, "{name}: {} bytes", bytes.len());
        let tx: VersionedTransaction = bincode::deserialize(&bytes).unwrap();
        let (user0, fee0, coin0) = (lamports(&svm, user), lamports(&svm, FEE_WALLET), coins(&svm, user_coin));
        let res = svm.send_transaction(tx);
        match (step["expect"].as_str().unwrap(), &res) {
            ("ok", Ok(_)) => {}
            ("ok", Err(e)) => panic!("{name}: {:?} :: {}", e.err, e.meta.logs.join(" | ")),
            ("error", Ok(_)) => panic!("{name}: expected a refusal, but it went through"),
            ("error", Err(e)) => {
                let logs = e.meta.logs.join(" | ");
                if let Some(why) = step["reason"].as_str() { assert!(logs.contains(why), "{name}: expected {why}, got {logs}"); }
                println!("refused as expected: {:?}", e.err);
            }
            (x, _) => panic!("unknown expectation {x}"),
        }
        let checks = &step["checks"];
        if checks["coins_to_user"].as_bool() == Some(true) {
            let got = coins(&svm, user_coin) - coin0;
            assert!(got > 0, "{name}: the coins reached the user");
            println!("{name}: {got} units of the coin to the user");
        }
        if checks["sol_to_user"].as_bool() == Some(true) {
            assert!(lamports(&svm, user) > user0, "{name}: SOL reached the user");
            println!("{name}: {} lamports to the user (and the order's deposit back)", lamports(&svm, user) - user0);
        }
        if checks["fee_sol"].as_bool() == Some(true) {
            let fee = lamports(&svm, FEE_WALLET) - fee0;
            assert!(fee > 0, "{name}: 1% to the fee wallet");
            println!("{name}: {fee} lamports to the fee wallet");
        }
        assert_eq!(lamports(&svm, transit), 0, "{name}: transit holds nothing");
        println!("ok: {name} ({} bytes)", bytes.len());
    }
}
