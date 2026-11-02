// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title Sign-in check for smart wallets that aren't deployed yet (EIP-6492)
 * @notice Never deployed. RektBull's server runs this contract's creation code
 *         in a read-only `eth_call` with no `to` (a "deployless" call): the
 *         constructor runs, answers one byte, and nothing is written onchain.
 *
 *         A smart wallet that has never sent a transaction (for example a new
 *         Coinbase Smart Wallet) has no code yet, so it can't answer EIP-1271's
 *         isValidSignature. EIP-6492 wraps its signature with the factory call
 *         that would create it. This constructor makes that factory call (inside
 *         the eth_call only), then asks the now-existing wallet whether it
 *         accepts the signature.
 *
 *         Answers 0x01 if `signer` accepts `signature` for `hash`, else 0x00.
 *         The factory call can only put code at `signer` if `signer` really is
 *         that factory's address for that calldata (CREATE2), so a wrong
 *         factory or calldata leaves no wallet to answer, and the answer is 0x00.
 */
contract SignInCheck6492 {
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    constructor(address signer, bytes32 hash, address factory, bytes memory factoryCalldata, bytes memory signature) {
        if (signer.code.length == 0 && factory != address(0)) {
            // A failed factory call simply leaves no wallet; checked just below.
            (bool created,) = factory.call(factoryCalldata);
            created;
        }
        bool valid;
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(ERC1271_MAGIC, hash, signature));
            valid = ok && ret.length >= 32 && bytes4(abi.decode(ret, (bytes32))) == ERC1271_MAGIC;
        }
        assembly {
            mstore(0, valid)
            return(31, 1)
        }
    }
}
