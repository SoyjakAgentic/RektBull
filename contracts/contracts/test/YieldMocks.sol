// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// Test-only ERC-4626 vault (OpenZeppelin's standard implementation), like Spark's sUSDC: 18-decimal
/// shares over a 6-decimal asset, so one share unit is worth a tiny fraction of a cent.
contract MockVault4626 is ERC4626 {
    constructor(IERC20 asset_) ERC20("Savings USDC", "sUSDC") ERC4626(asset_) {}
    function _decimalsOffset() internal pure override returns (uint8) { return 12; }
}

/// Test-only Savings Rate oracle (Sky's SSR, a per-second rate in RAY), settable.
contract MockSsrOracle {
    uint256 public ssr = 1e27;
    function set(uint256 ssr_) external { ssr = ssr_; }
    function getSSR() external view returns (uint256) { return ssr; }
}

/// Test-only Safe: records every call a module asks it to make, and makes none.
contract MockSafe {
    struct Call { address to; uint256 value; bytes4 selector; uint8 operation; address module; }
    Call[] public calls;
    mapping(address => bool) public moduleEnabled;
    function enableModule(address m) external { moduleEnabled[m] = true; }
    function disableModule(address m) external { moduleEnabled[m] = false; }
    /// The Safe's owners act: calls `to` from the Safe (e.g. the module's setSession or revoke).
    function ownerCall(address to, bytes calldata data) external {
        (bool ok, bytes memory r) = to.call(data);
        require(ok, string(r));
    }
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes memory data, uint8 operation)
        external returns (bool, bytes memory)
    {
        require(moduleEnabled[msg.sender], "GS104");
        calls.push(Call(to, value, bytes4(data), operation, msg.sender));
        return (true, abi.encode(uint256(1)));
    }
    function callCount() external view returns (uint256) { return calls.length; }
}
