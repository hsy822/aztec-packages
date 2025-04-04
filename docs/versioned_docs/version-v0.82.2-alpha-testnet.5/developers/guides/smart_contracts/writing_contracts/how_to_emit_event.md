---
title: Emitting Events
sidebar_position: 4
tags: [contracts]
---

Events in Aztec work similarly to Ethereum events in the sense that they are a way for contracts to communicate with the outside world.
They are emitted by contracts and stored inside each instance of an AztecNode.

:::info
Aztec events are currently represented as raw data and are not ABI encoded.
ABI encoded events are a feature that will be added in the future.
:::

Unlike on Ethereum, there are 2 types of events supported by Aztec: [encrypted](#encrypted-events) and [unencrypted](#unencrypted-events).

## Encrypted Events

### Call emit

To emit encrypted logs you can import the `encode_and_encrypt` or `encode_and_encrypt_with_keys` functions and pass them into the `emit` function after inserting a note. An example can be seen in the reference token contract's transfer function:

```rust title="encrypted" showLineNumbers 
storage.balances.at(from).sub(from, amount).emit(encode_and_encrypt_note(
    &mut context,
    from,
    from,
));
```
> <sup><sub><a href="https://github.com/AztecProtocol/aztec-packages/blob/master/noir-projects/noir-contracts/contracts/token_contract/src/main.nr#L372-L378" target="_blank" rel="noopener noreferrer">Source code: noir-projects/noir-contracts/contracts/token_contract/src/main.nr#L372-L378</a></sub></sup>


Furthermore, if not emitting the note, one should explicitly `discard` the value returned from the note creation.

### Successfully process the encrypted event

Contracts created using aztec-nr will try to discover newly created notes by searching for logs emitted for any of the accounts registered inside PXE, decrypting their contents and notifying PXE of any notes found. This process is automatic and occurs whenever a contract function is invoked.

## Unencrypted Events

Unencrypted events are events which can be read by anyone. They can be emitted **only** by public functions.

### Call emit_public_log

To emit public logs you don't need to import any library. You call the context method `emit_public_log`:

```rust title="emit_public" showLineNumbers 
context.emit_public_log(/*message=*/ value);
context.emit_public_log(/*message=*/ [10, 20, 30]);
context.emit_public_log(/*message=*/ "Hello, world!");
```
> <sup><sub><a href="https://github.com/AztecProtocol/aztec-packages/blob/master/noir-projects/noir-contracts/contracts/test_contract/src/main.nr#L387-L391" target="_blank" rel="noopener noreferrer">Source code: noir-projects/noir-contracts/contracts/test_contract/src/main.nr#L387-L391</a></sub></sup>


### Querying the unencrypted event

Once emitted, unencrypted events are stored in AztecNode and can be queried by anyone:

```typescript title="get_logs" showLineNumbers 
const fromBlock = await pxe.getBlockNumber();
const logFilter = {
  fromBlock,
  toBlock: fromBlock + 1,
};
const publicLogs = (await pxe.getPublicLogs(logFilter)).logs;
```
> <sup><sub><a href="https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/end-to-end/src/e2e_ordering.test.ts#L23-L30" target="_blank" rel="noopener noreferrer">Source code: yarn-project/end-to-end/src/e2e_ordering.test.ts#L23-L30</a></sub></sup>


## Costs

All event data is pushed to Ethereum as calldata by the sequencer and for this reason the cost of emitting an event is non-trivial.

In the Sandbox, an encrypted note has a fixed overhead of 4 field elements (to broadcast an ephemeral public key, a contract address, and a storage slot); plus a variable number of field elements depending on the type of note being emitted.

A `ValueNote`, for example, currently uses 3 fields elements (plus the fixed overhead of 4). That's roughly `7 * 32 = 224` bytes of information.

```- title="value-note-def" showLineNumbers 
#[note]
#[derive(Eq)]
pub struct ValueNote {
    value: Field,
    owner: AztecAddress,
    randomness: Field,
}
```
> <sup><sub><a href="https://github.com/AztecProtocol/aztec-packages/blob/master/noir-projects/aztec-nr/value-note/src/value_note.nr#L3-L11" target="_blank" rel="noopener noreferrer">Source code: noir-projects/aztec-nr/value-note/src/value_note.nr#L3-L11</a></sub></sup>


- There are plans to compress encrypted note data further.
- There are plans to adopt EIP-4844 blobs to reduce the cost of data submission further.
