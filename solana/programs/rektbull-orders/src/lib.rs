//! RektBull order program: automatic meme trades on Solana from orders the user places, filled only at
//! the user's own price. The Solana twin of contracts/contracts/RektBullMemeRouter.sol; see
//! docs/SOLANA_ORDERS.md for the design and the guarantees.
//!
//! - The user places an order (an account only they can create or close) and approves this program's
//!   `delegate` address on the token account being sold, for the amount being sold.
//! - The executor the user named (RektBull's trade key) fills it, in parts or at once, through pump.fun
//!   or Jupiter. The input comes only from the order's owner, at most the order's size over all fills; the
//!   output, and any unused input, goes only to the owner; what reaches the owner must be at least the
//!   user's price, pro rata, after RektBull's fee.
//! - The fee is FEE_BPS (1%) at most, on the base-asset side (SOL, USDC, USDT), only to FEE_WALLET.
//! - The program holds nothing between transactions. It has no admin and no settings; after the audit its
//!   upgrade authority is removed, so nobody can change it.
//!
//! Two program addresses with separate jobs:
//! - `delegate` is the only address users approve. It signs one thing: moving a fill's input from the
//!   order's owner to `transit`. It never signs anything a venue sees.
//! - `transit` signs the trade on the venue. It is never approved by anyone, so a venue call signed by it
//!   can only reach what this fill put in it.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    system_instruction,
};
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("CYiK4necGUc4CZZmGM9CALRAurATaE1qR3dc6UJoUAsZ");

/// RektBull's fee, in basis points of the base-asset side of each fill: 1%. A constant: it can't be raised.
pub const FEE_BPS: u64 = 100;

/// Where fees go. Receive-only. **Placeholder until the owner creates RektBull's Solana fee wallet** (a
/// hardware wallet): set it here before the audit freeze; docs/SOLANA_ORDERS.md's deployment steps check it. The
/// wallet must hold at least the rent-exempt minimum of SOL before the first fill, or fills that pay it in SOL fail.
pub const FEE_WALLET: Pubkey = pubkey!("FeeWa11et1111111111111111111111111111111111");

/// The only programs a fill may call.
pub const PUMP_FUN: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_AMM: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const JUPITER_V6: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
pub const VENUES: [Pubkey; 3] = [PUMP_FUN, PUMP_AMM, JUPITER_V6];

/// Base assets: the fee is taken on whichever side of a fill is one of these.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const USDT_MINT: Pubkey = pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

pub const ORDER_SEED: &[u8] = b"order";
pub const DELEGATE_SEED: &[u8] = b"delegate";
pub const TRANSIT_SEED: &[u8] = b"transit";

pub fn is_base(mint: &Pubkey) -> bool {
    *mint == WSOL_MINT || *mint == USDC_MINT || *mint == USDT_MINT
}

/// ceil(a * b / c), without overflow.
pub fn mul_div_ceil(a: u64, b: u64, c: u64) -> Option<u64> {
    if c == 0 {
        return None;
    }
    let p = (a as u128).checked_mul(b as u128)?;
    u64::try_from(p.div_ceil(c as u128)).ok()
}

/// RektBull's fee on an amount (rounded down: never more than FEE_BPS).
pub fn fee_of(amount: u64) -> u64 {
    ((amount as u128) * (FEE_BPS as u128) / 10_000) as u64
}

#[program]
pub mod rektbull_orders {
    use super::*;

    /// The owner places an order. Only they can, and only they can cancel it.
    pub fn place_order(ctx: Context<PlaceOrder>, nonce: u64, p: OrderParams) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(p.amount_in > 0, OrderError::BadOrder);
        // An order with no minimum could be filled at any price (the EVM router's fuzzing found this).
        require!(p.min_amount_out > 0, OrderError::NoMinimum);
        require!(p.valid_until > now && p.valid_until > p.valid_after, OrderError::BadOrder);
        require!(p.input_mint != p.output_mint, OrderError::BadOrder);
        // Native SOL out is spelled as the wrapped SOL mint plus output_native.
        require!(!p.output_native || p.output_mint == WSOL_MINT, OrderError::BadOrder);
        require!(p.executor != Pubkey::default(), OrderError::BadOrder);

        let o = &mut ctx.accounts.order;
        o.owner = ctx.accounts.owner.key();
        o.executor = p.executor;
        o.input_mint = p.input_mint;
        o.output_mint = p.output_mint;
        o.output_native = p.output_native;
        o.amount_in = p.amount_in;
        o.min_amount_out = p.min_amount_out;
        o.filled_in = 0;
        o.valid_after = p.valid_after;
        o.valid_until = p.valid_until;
        o.nonce = nonce;
        o.bump = ctx.bumps.order;
        emit!(OrderPlaced { order: o.key(), owner: o.owner, input_mint: o.input_mint, output_mint: o.output_mint, amount_in: o.amount_in, min_amount_out: o.min_amount_out, valid_until: o.valid_until });
        Ok(())
    }

    /// The owner cancels an order; its rent comes back to them. (To stop every sell order at once, the
    /// owner can also revoke the delegate on the token account.)
    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        emit!(OrderCancelled { order: ctx.accounts.order.key(), owner: ctx.accounts.owner.key() });
        Ok(())
    }

    /// The executor fills `amount_in` of the order through an allowed venue. `venue_data` is the venue's
    /// own instruction; its accounts are the remaining accounts, with `transit` as the trader.
    /// `unwrap_in`: the input is wrapped SOL, sent to the venue as native SOL (pump.fun's curve is bought
    /// with SOL); unused SOL goes back to the owner as native SOL. For an order paying out native SOL through an
    /// exchange that pays wrapped SOL (PumpSwap, Jupiter), `transit_out` is transit's wrapped-SOL account: it is
    /// unwrapped after the exchange call.
    pub fn fill<'info>(
        ctx: Context<'_, '_, 'info, 'info, Fill<'info>>,
        amount_in: u64,
        unwrap_in: bool,
        venue_data: Vec<u8>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let order = &ctx.accounts.order;
        require!(now >= order.valid_after, OrderError::TooEarly);
        require!(now <= order.valid_until, OrderError::Expired);
        let left = order.amount_in - order.filled_in;
        require!(amount_in > 0 && amount_in <= left, OrderError::OverSize);
        require!(VENUES.contains(ctx.accounts.venue.key), OrderError::VenueNotAllowed);
        require!(ctx.accounts.venue.executable, OrderError::VenueNotAllowed);
        require!(!unwrap_in || (order.input_mint == WSOL_MINT && !order.output_native), OrderError::BadFill);
        // The user's price for this part: ceil(min_amount_out * amount_in / amount_in_total).
        let minimum = mul_div_ceil(order.min_amount_out, amount_in, order.amount_in).ok_or(OrderError::Math)?;
        let output_native = order.output_native;
        let fee_on_input = is_base(&order.input_mint);
        let fee_on_output = !fee_on_input && (output_native || is_base(&order.output_mint));

        let a = &ctx.accounts;
        let transit_bump = ctx.bumps.transit;
        let transit_seeds: &[&[u8]] = &[TRANSIT_SEED, &[transit_bump]];
        let delegate_seeds: &[&[u8]] = &[DELEGATE_SEED, &[ctx.bumps.delegate]];

        // What has reached the owner so far: measured again at the end.
        let owner_lamports_before = a.owner.lamports();
        let owner_out_before = match &a.owner_out {
            Some(acc) => acc.amount,
            None => 0,
        };
        // Output accounts must match the order.
        if output_native {
            // Native SOL out. An exchange that pays wrapped SOL (PumpSwap, Jupiter) pays it into transit's
            // wrapped-SOL account, passed as transit_out; it is unwrapped after the exchange call.
            require!(a.owner_out.is_none(), OrderError::BadFill);
            if let Some(transit_out) = &a.transit_out {
                require_keys_eq!(transit_out.mint, WSOL_MINT, OrderError::BadFill);
                require_keys_eq!(transit_out.owner, a.transit.key(), OrderError::BadFill);
                require!(a.output_token_program.is_some(), OrderError::BadFill);
            }
        } else {
            let (Some(owner_out), Some(transit_out), Some(mint)) = (&a.owner_out, &a.transit_out, &a.output_mint) else {
                return err!(OrderError::BadFill);
            };
            require_keys_eq!(mint.key(), order.output_mint, OrderError::BadFill);
            require_keys_eq!(owner_out.mint, order.output_mint, OrderError::BadFill);
            require_keys_eq!(owner_out.owner, order.owner, OrderError::BadFill);
            require_keys_eq!(transit_out.mint, order.output_mint, OrderError::BadFill);
            require_keys_eq!(transit_out.owner, a.transit.key(), OrderError::BadFill);
        }

        // 1. The input, from the order's owner only (the delegate's one job).
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.input_token_program.to_account_info(),
                TransferChecked {
                    from: a.source.to_account_info(),
                    mint: a.input_mint.to_account_info(),
                    to: a.transit_in.to_account_info(),
                    authority: a.delegate.to_account_info(),
                },
                &[delegate_seeds],
            ),
            amount_in,
            a.input_mint.decimals,
        )?;

        // 2. The fee on the input side (when the input is SOL, USDC or USDT).
        let mut fee: u64 = 0;
        if unwrap_in {
            // Unwrap: close transit's wrapped-SOL account into transit; the account's rent goes back to the
            // executor who opened it, the SOL stays for the venue.
            let before = a.transit.lamports();
            token_interface::close_account(CpiContext::new_with_signer(
                a.input_token_program.to_account_info(),
                CloseAccount {
                    account: a.transit_in.to_account_info(),
                    destination: a.transit.to_account_info(),
                    authority: a.transit.to_account_info(),
                },
                &[transit_seeds],
            ))?;
            let got = a.transit.lamports().checked_sub(before).ok_or(OrderError::Math)?;
            let rent = got.checked_sub(amount_in).ok_or(OrderError::Math)?;
            send_lamports(&a.transit, &a.executor.to_account_info(), &a.system_program, rent, transit_seeds)?;
            fee = fee_of(amount_in);
            send_lamports(&a.transit, &a.fee_wallet.to_account_info(), &a.system_program, fee, transit_seeds)?;
        } else if fee_on_input {
            fee = fee_of(amount_in);
            let fee_in = a.fee_in.as_ref().ok_or(OrderError::BadFill)?;
            require_keys_eq!(fee_in.mint, order.input_mint, OrderError::BadFill);
            require_keys_eq!(fee_in.owner, FEE_WALLET, OrderError::BadFill);
            if fee > 0 {
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        a.input_token_program.to_account_info(),
                        TransferChecked {
                            from: a.transit_in.to_account_info(),
                            mint: a.input_mint.to_account_info(),
                            to: fee_in.to_account_info(),
                            authority: a.transit.to_account_info(),
                        },
                        &[transit_seeds],
                    ),
                    fee,
                    a.input_mint.decimals,
                )?;
            }
        }

        // 3. The venue, with transit as the trader. Nothing else this program controls signs.
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|acc| {
                require_keys_neq!(*acc.key, a.delegate.key(), OrderError::BadFill);
                Ok(AccountMeta {
                    pubkey: *acc.key,
                    is_signer: acc.is_signer || *acc.key == a.transit.key(),
                    is_writable: acc.is_writable,
                })
            })
            .collect::<Result<_>>()?;
        let mut infos: Vec<AccountInfo<'info>> = ctx.remaining_accounts.to_vec();
        infos.push(a.transit.to_account_info());
        infos.push(a.venue.to_account_info());
        invoke_signed(
            &Instruction { program_id: a.venue.key(), accounts: metas, data: venue_data },
            &infos,
            &[transit_seeds],
        )?;

        // 4. The output to the owner (less the fee on the output side), and unused input back.
        if output_native {
            if let Some(transit_out) = &a.transit_out {
                // Unwrap: close transit's wrapped-SOL account into transit. Its rent goes back to the executor
                // who opened it; the wrapped SOL it held is this fill's proceeds.
                let mut t = transit_out.clone();
                t.reload()?;
                let before = a.transit.lamports();
                token_interface::close_account(CpiContext::new_with_signer(
                    a.output_token_program.as_ref().ok_or(OrderError::BadFill)?.to_account_info(),
                    CloseAccount {
                        account: transit_out.to_account_info(),
                        destination: a.transit.to_account_info(),
                        authority: a.transit.to_account_info(),
                    },
                    &[transit_seeds],
                ))?;
                let got = a.transit.lamports().checked_sub(before).ok_or(OrderError::Math)?;
                let rent = got.checked_sub(t.amount).ok_or(OrderError::Math)?;
                send_lamports(&a.transit, &a.executor.to_account_info(), &a.system_program, rent, transit_seeds)?;
            }
            // Everything transit now holds is this fill's proceeds.
            let out = a.transit.lamports();
            if fee_on_output {
                fee = fee_of(out);
                send_lamports(&a.transit, &a.fee_wallet.to_account_info(), &a.system_program, fee, transit_seeds)?;
            }
            send_lamports(&a.transit, &a.owner.to_account_info(), &a.system_program, a.transit.lamports(), transit_seeds)?;
        } else {
            let transit_out = a.transit_out.as_ref().unwrap();
            let owner_out = a.owner_out.as_ref().unwrap();
            let out_mint = a.output_mint.as_ref().unwrap();
            let out_program = a.output_token_program.as_ref().ok_or(OrderError::BadFill)?;
            let mut transit_out_info = transit_out.clone();
            transit_out_info.reload()?;
            let mut out = transit_out_info.amount;
            if fee_on_output && out > 0 {
                fee = fee_of(out);
                let fee_out = a.fee_out.as_ref().ok_or(OrderError::BadFill)?;
                require_keys_eq!(fee_out.mint, order.output_mint, OrderError::BadFill);
                require_keys_eq!(fee_out.owner, FEE_WALLET, OrderError::BadFill);
                if fee > 0 {
                    token_interface::transfer_checked(
                        CpiContext::new_with_signer(
                            out_program.to_account_info(),
                            TransferChecked { from: transit_out.to_account_info(), mint: out_mint.to_account_info(), to: fee_out.to_account_info(), authority: a.transit.to_account_info() },
                            &[transit_seeds],
                        ),
                        fee,
                        out_mint.decimals,
                    )?;
                }
                out -= fee;
            }
            if out > 0 {
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        out_program.to_account_info(),
                        TransferChecked { from: transit_out.to_account_info(), mint: out_mint.to_account_info(), to: owner_out.to_account_info(), authority: a.transit.to_account_info() },
                        &[transit_seeds],
                    ),
                    out,
                    out_mint.decimals,
                )?;
            }
            // Unused native input (a curve buy that spent less) goes back to the owner as SOL.
            let rest = a.transit.lamports();
            if rest > 0 {
                send_lamports(&a.transit, &a.owner.to_account_info(), &a.system_program, rest, transit_seeds)?;
            }
        }
        if !unwrap_in {
            // Unused token input goes back to the account it came from.
            let mut t_in = a.transit_in.clone();
            t_in.reload()?;
            if t_in.amount > 0 {
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        a.input_token_program.to_account_info(),
                        TransferChecked { from: a.transit_in.to_account_info(), mint: a.input_mint.to_account_info(), to: a.source.to_account_info(), authority: a.transit.to_account_info() },
                        &[transit_seeds],
                    ),
                    t_in.amount,
                    a.input_mint.decimals,
                )?;
            }
        }

        // 5. The user's price, on what actually reached them (a token that taxes transfers can't leave
        //    them short).
        let delivered = if output_native {
            a.owner.lamports().checked_sub(owner_lamports_before).ok_or(OrderError::Math)?
        } else {
            let mut owner_out = a.owner_out.as_ref().unwrap().clone();
            owner_out.reload()?;
            owner_out.amount.checked_sub(owner_out_before).ok_or(OrderError::Math)?
        };
        require!(delivered >= minimum, OrderError::BelowLimit);
        // Transit holds nothing between transactions.
        require!(a.transit.lamports() == 0, OrderError::Leftover);

        let order = &mut ctx.accounts.order;
        order.filled_in += amount_in;
        emit!(Filled { order: order.key(), owner: order.owner, amount_in, fee, delivered, minimum });
        if order.filled_in == order.amount_in {
            // Done: the order's rent goes back to the owner.
            order.close(ctx.accounts.owner.to_account_info())?;
        }
        Ok(())
    }
}

fn send_lamports<'info>(
    from: &UncheckedAccount<'info>,
    to: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    lamports: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    invoke_signed(
        &system_instruction::transfer(from.key, to.key, lamports),
        &[from.to_account_info(), to.clone(), system_program.to_account_info()],
        &[seeds],
    )?;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OrderParams {
    pub executor: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub output_native: bool,
    pub amount_in: u64,
    pub min_amount_out: u64,
    pub valid_after: i64,
    pub valid_until: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Order {
    /// Whose order: the input comes only from them, the output goes only to them.
    pub owner: Pubkey,
    /// The only key that may fill it: RektBull's trade key.
    pub executor: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    /// The output is delivered as native SOL (output_mint is then wrapped SOL).
    pub output_native: bool,
    /// The most that may be sold over all fills.
    pub amount_in: u64,
    /// The least selling all of amount_in must bring the owner, after the fee: a limit price.
    pub min_amount_out: u64,
    pub filled_in: u64,
    pub valid_after: i64,
    pub valid_until: i64,
    pub nonce: u64,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct PlaceOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Order::INIT_SPACE, seeds = [ORDER_SEED, owner.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub order: Account<'info, Order>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ OrderError::NotOwner, close = owner)]
    pub order: Account<'info, Order>,
}

#[derive(Accounts)]
pub struct Fill<'info> {
    #[account(mut)]
    pub executor: Signer<'info>,
    #[account(mut, has_one = owner @ OrderError::BadFill, has_one = executor @ OrderError::NotExecutor)]
    pub order: Account<'info, Order>,
    /// CHECK: the order's owner (has_one above). Receives native output, unused SOL and the order's rent.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: this program's delegate address; holds nothing, signs only step 1.
    #[account(seeds = [DELEGATE_SEED], bump)]
    pub delegate: UncheckedAccount<'info>,
    /// CHECK: this program's transit address, a system account that holds a fill's funds during the fill only.
    #[account(mut, seeds = [TRANSIT_SEED], bump)]
    pub transit: UncheckedAccount<'info>,
    /// The owner's token account the input comes from.
    #[account(mut, token::mint = input_mint, token::authority = owner, token::token_program = input_token_program)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = order.input_mint @ OrderError::BadFill, mint::token_program = input_token_program)]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = input_mint, token::authority = transit, token::token_program = input_token_program)]
    pub transit_in: Box<InterfaceAccount<'info, TokenAccount>>,
    pub input_token_program: Interface<'info, TokenInterface>,
    /// Token output only: its mint, transit's account for it, the owner's account for it, its token program.
    pub output_mint: Option<Box<InterfaceAccount<'info, Mint>>>,
    #[account(mut)]
    pub transit_out: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)]
    pub owner_out: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub output_token_program: Option<Interface<'info, TokenInterface>>,
    /// The fee wallet; and its token account when the fee is in a token.
    /// CHECK: the fixed fee wallet.
    #[account(mut, address = FEE_WALLET @ OrderError::BadFill)]
    pub fee_wallet: UncheckedAccount<'info>,
    #[account(mut)]
    pub fee_in: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut)]
    pub fee_out: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// CHECK: one of VENUES, checked in the handler.
    pub venue: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct OrderPlaced { pub order: Pubkey, pub owner: Pubkey, pub input_mint: Pubkey, pub output_mint: Pubkey, pub amount_in: u64, pub min_amount_out: u64, pub valid_until: i64 }
#[event]
pub struct OrderCancelled { pub order: Pubkey, pub owner: Pubkey }
#[event]
pub struct Filled { pub order: Pubkey, pub owner: Pubkey, pub amount_in: u64, pub fee: u64, pub delivered: u64, pub minimum: u64 }

#[error_code]
pub enum OrderError {
    #[msg("order parameters are invalid")]
    BadOrder,
    #[msg("an order needs a minimum output")]
    NoMinimum,
    #[msg("only the order's owner can do this")]
    NotOwner,
    #[msg("only the order's executor can fill it")]
    NotExecutor,
    #[msg("the order's window hasn't started")]
    TooEarly,
    #[msg("the order has expired")]
    Expired,
    #[msg("more than is left of the order")]
    OverSize,
    #[msg("that program isn't an allowed venue")]
    VenueNotAllowed,
    #[msg("the fill's accounts don't match the order")]
    BadFill,
    #[msg("less than the user's price reached them")]
    BelowLimit,
    #[msg("transit would be left holding funds")]
    Leftover,
    #[msg("arithmetic")]
    Math,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimum_is_pro_rata_and_rounds_up() {
        assert_eq!(mul_div_ceil(1_000, 1, 3), Some(334));
        assert_eq!(mul_div_ceil(1_000, 3, 3), Some(1_000));
        // A tiny part of an order still needs at least 1 unit out: never zero.
        assert_eq!(mul_div_ceil(1, 1, 1_000_000), Some(1));
        assert_eq!(mul_div_ceil(u64::MAX, u64::MAX, u64::MAX), Some(u64::MAX));
        assert_eq!(mul_div_ceil(1, 1, 0), None);
    }

    #[test]
    fn fee_is_at_most_one_percent_and_rounds_down() {
        assert_eq!(fee_of(10_000), 100);
        assert_eq!(fee_of(99), 0);
        assert_eq!(fee_of(u64::MAX), u64::MAX / 100);
        for x in [1u64, 7, 101, 12_345, 1 << 40] {
            assert!(fee_of(x) * 100 <= x);
        }
    }

    #[test]
    fn base_assets() {
        assert!(is_base(&WSOL_MINT) && is_base(&USDC_MINT) && is_base(&USDT_MINT));
        assert!(!is_base(&Pubkey::new_unique()));
    }

    #[test]
    fn venue_list_is_fixed() {
        assert_eq!(VENUES.len(), 3);
        assert!(!VENUES.contains(&crate::ID));
    }
}
