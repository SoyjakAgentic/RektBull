//! Test-only stand-in exchange for the RektBull order program's tests (loaded at an allowed venue's
//! address in the test chain). Swaps at whatever rate the test asks, and can misbehave on purpose.
//! Never deployed.
//!
//! Instruction data: [op: u8][a: u64 LE][b: u64 LE]. The vault is the PDA ["vault"], a system account that
//! holds SOL and is the authority of the venue's token accounts.

use anchor_lang::solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
};
use anchor_spl::token_2022::spl_token_2022::{extension::StateWithExtensions, instruction::transfer_checked, state::Mint};

entrypoint!(process);

fn decimals(mint: &AccountInfo) -> Result<u8, ProgramError> {
    let data = mint.try_borrow_data()?;
    Ok(StateWithExtensions::<Mint>::unpack(&data)?.base.decimals)
}

fn token_transfer<'a>(
    program: &AccountInfo<'a>,
    from: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    let ix = transfer_checked(program.key, from.key, mint.key, to.key, authority.key, &[], amount, decimals(mint)?)?;
    let infos = [from.clone(), mint.clone(), to.clone(), authority.clone(), program.clone()];
    match seeds {
        Some(s) => invoke_signed(&ix, &infos, &[s]),
        None => invoke(&ix, &infos),
    }
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 17 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let op = data[0];
    let a = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let b = u64::from_le_bytes(data[9..17].try_into().unwrap());
    let (vault, bump) = Pubkey::find_program_address(&[b"vault"], program_id);
    let vault_seeds: &[&[u8]] = &[b"vault", &[bump]];
    let it = &mut accounts.iter();
    match op {
        // Tokens in, tokens out: [trader (signer), from, in_mint, vault_in, vault_out, out_mint, to, vault, token_in_program, token_out_program]
        0 => {
            let (trader, from, in_mint, vault_in, vault_out, out_mint, to, v, p_in, p_out) = (
                next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?,
                next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?,
            );
            assert_eq!(*v.key, vault);
            token_transfer(p_in, from, in_mint, vault_in, trader, a, None)?;
            token_transfer(p_out, vault_out, out_mint, to, v, b, Some(vault_seeds))
        }
        // SOL in, tokens out: [trader (signer, system account), vault, vault_out, out_mint, to, token_program, system_program]
        1 => {
            let (trader, v, vault_out, out_mint, to, p, sys) = (
                next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?,
                next_account_info(it)?, next_account_info(it)?, next_account_info(it)?,
            );
            assert_eq!(*v.key, vault);
            invoke(&system_instruction::transfer(trader.key, v.key, a), &[trader.clone(), v.clone(), sys.clone()])?;
            token_transfer(p, vault_out, out_mint, to, v, b, Some(vault_seeds))
        }
        // Tokens in, SOL out: [trader (signer), from, in_mint, vault_in, vault, to (gets SOL), token_program, system_program]
        2 => {
            let (trader, from, in_mint, vault_in, v, to, p, sys) = (
                next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?,
                next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?,
            );
            assert_eq!(*v.key, vault);
            token_transfer(p, from, in_mint, vault_in, trader, a, None)?;
            if b > 0 {
                invoke_signed(&system_instruction::transfer(v.key, to.key, b), &[v.clone(), to.clone(), sys.clone()], &[vault_seeds])?;
            }
            Ok(())
        }
        // Theft attempt: move `a` tokens out of a victim's account, with whatever signer the caller passed as
        // `authority`: [authority, victim, mint, to, token_program]
        3 => {
            let (authority, victim, mint, to, p) = (
                next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?,
            );
            token_transfer(p, victim, mint, to, authority, a, None)
        }
        // Theft attempt: move `a` lamports from `from` (e.g. the order's owner) to `to`: [from, to, system_program]
        4 => {
            let (from, to, sys) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            invoke(&system_instruction::transfer(from.key, to.key, a), &[from.clone(), to.clone(), sys.clone()])
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
