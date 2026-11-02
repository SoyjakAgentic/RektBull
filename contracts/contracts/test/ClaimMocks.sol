// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// Test-only Uniswap-style airdrop: claim(index, account, amount, proof) once per index.
contract MockMerkleDistributor {
    address public immutable token;
    bytes32 public immutable merkleRoot;
    mapping(uint256 => bool) private claimedIndex;

    constructor(address token_, bytes32 merkleRoot_) { token = token_; merkleRoot = merkleRoot_; }

    function isClaimed(uint256 index) public view returns (bool) { return claimedIndex[index]; }

    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        require(!claimedIndex[index], "already claimed");
        bytes32 node = keccak256(abi.encodePacked(index, account, amount));
        require(MerkleProof.verify(proof, merkleRoot, node), "invalid proof");
        claimedIndex[index] = true;
        require(IERC20(token).transfer(account, amount), "transfer failed");
    }
}

/**
 * Test-only stand-in for Merkl's Distributor, put at Merkl's address with
 * hardhat_setCode: cumulative amounts per (user, token), the same leaf, the
 * same claim(users, tokens, amounts, proofs) and the same rule that only the
 * user may claim for themselves.
 */
contract MockMerklDistributor {
    struct Claim { uint208 amount; uint48 timestamp; bytes32 merkleRoot; }
    bytes32 private root;
    mapping(address => mapping(address => Claim)) public claimed;

    function setRoot(bytes32 root_) external { root = root_; }
    function getMerkleRoot() external view returns (bytes32) { return root; }

    function claim(address[] calldata users, address[] calldata tokens, uint256[] calldata amounts, bytes32[][] calldata proofs) external {
        for (uint256 i = 0; i < users.length; i++) {
            require(msg.sender == users[i], "NotWhitelisted");
            bytes32 leaf = keccak256(abi.encode(users[i], tokens[i], amounts[i]));
            require(MerkleProof.verify(proofs[i], root, leaf), "InvalidProof");
            uint256 toSend = amounts[i] - claimed[users[i]][tokens[i]].amount;
            claimed[users[i]][tokens[i]] = Claim(uint208(amounts[i]), uint48(block.timestamp), root);
            require(IERC20(tokens[i]).transfer(users[i], toSend), "transfer failed");
        }
    }
}

/// Test-only points token: only its minter (the distributor) may send it, like reward points before launch.
contract MockLockedToken is ERC20 {
    address public immutable minter;
    constructor(address minter_) ERC20("Locked Points", "PTS") { minter = minter_; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || from == minter, "not transferable yet");
        super._update(from, to, value);
    }
}
