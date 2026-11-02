// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// Test-only token anyone can mint.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) { _decimals = decimals_; }
    function decimals() public view override returns (uint8) { return _decimals; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// Test-only Chainlink-style feed whose answer and age can be set.
contract MockFeed {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;
    uint256 public startedAt;
    constructor(uint8 decimals_, int256 answer_) { decimals = decimals_; answer = answer_; updatedAt = block.timestamp; startedAt = 1; }
    function set(int256 answer_, uint256 updatedAt_) external { answer = answer_; updatedAt = updatedAt_; }
    function setStartedAt(uint256 startedAt_) external { startedAt = startedAt_; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, updatedAt, 1);
    }
}

/**
 * Test-only exchange. swap() takes amountIn of tokenIn from the caller and
 * mints tokenOut at rate (out per 1e18 in, in raw units) to `to`. Tests use
 * `to` and the rate to play a dishonest exchange: paying someone else, or
 * paying a bad price.
 */
contract MockVenue {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 rate, address to) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(tokenOut).mint(to, amountIn * rate / 1e18);
    }
    /// Tries to take more than it was approved for.
    function greedy(address tokenIn, address tokenOut, uint256 amountIn, uint256 rate) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn * 2);
        MockERC20(tokenOut).mint(msg.sender, amountIn * rate / 1e18);
    }
}

/// @dev A test NFT collection, for the approval cleanup tests.
contract MockNFT is ERC721 {
    constructor() ERC721("Test NFT", "tNFT") {}
    function mint(address to, uint256 id) external { _mint(to, id); }
}
