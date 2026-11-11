// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MockERC20} from "./Mocks.sol";

/// Test-only wrapped native coin (WETH9's deposit and withdraw).
contract MockWrappedNative is ERC20 {
    constructor() ERC20("Wrapped Native", "WNAT") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw");
    }
    receive() external payable { _mint(msg.sender, msg.value); }
}

/// Test-only contract wallet (like a Safe): signs through EIP-1271, with its owner's key.
contract MockSmartAccount {
    address public immutable owner;
    constructor(address owner_) { owner = owner_; }
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError e,) = ECDSA.tryRecover(hash, signature);
        return e == ECDSA.RecoverError.NoError && signer == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
    /// The owner makes the account call anything (an approval, a cancel).
    function exec(address to, bytes calldata data) external {
        require(msg.sender == owner, "owner");
        (bool ok, bytes memory r) = to.call(data);
        require(ok, string(r));
    }
    receive() external payable {}
}

/**
 * Test-only exchange for the native coin, like a launchpad's bonding curve:
 * sellForNative takes tokens and pays native at `rate` (native per 1e18 tokens) to `to`;
 * buyWithNative takes the native sent and mints tokens at `rate` (tokens per 1e18 native)
 * to `to`, refunding `keep` of it to the caller.
 */
contract MockNativeVenue {
    function sellForNative(address token, uint256 amount, uint256 rate, address to) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
        (bool ok,) = to.call{value: amount * rate / 1e18}("");
        require(ok, "pay");
    }
    function buyWithNative(address token, uint256 rate, address to, uint256 refund) external payable {
        MockERC20(token).mint(to, (msg.value - refund) * rate / 1e18);
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            require(ok, "refund");
        }
    }
    receive() external payable {}
}

/// Test-only meme coin that burns 5% of every transfer (a "tax token"); minting is untaxed.
contract MockTaxToken is ERC20 {
    constructor() ERC20("Taxed Meme", "TAX") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = value / 20;
            super._update(from, address(0), tax);
            value -= tax;
        }
        super._update(from, to, value);
    }
}
