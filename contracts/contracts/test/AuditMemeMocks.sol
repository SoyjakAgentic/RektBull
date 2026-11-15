// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./Mocks.sol";

/// Test-only (the second AI audit's proofs, test/memeRouterAudit.test.js): an exchange whose calldata names where each part of the output goes
/// (as 0x Settler actions, integrator-fee parameters or a sandwich would allow).
contract AuditSplitVenue {
    function swapSplit(address tokenIn, address tokenOut, uint256 amountIn, address a, uint256 toA, address b, uint256 toB) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(a, toA);
        MockERC20(tokenOut).mint(b, toB);
    }
    /// Pays the output and also hands some native coin to the caller (a rebate, a refund).
    function swapWithNativeRebate(address tokenIn, address tokenOut, uint256 amountIn, uint256 out, uint256 rebate) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(msg.sender, out);
        (bool ok,) = msg.sender.call{value: rebate}("");
        require(ok, "rebate");
    }
    receive() external payable {}
}

/// Test-only: code with no isValidSignature, standing in for an EOA that has delegated (EIP-7702).
contract AuditNoSig {
    fallback() external payable {}
}
