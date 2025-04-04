---
title: Transferring Tokens with Aztec.js
sidebar_position: 0
---

import Image from "@theme/IdealImage";

In this guide, we will retrieving the Sandbox and deploy a pre-written contract to it using Aztec.js.

This guide assumes you have followed the [quickstart](../../../../developers/getting_started.md).

## Prerequisites

- A running Aztec sandbox

## Set up the project

We will deploy a pre-compiled token contract, and send tokens privately, using the Sandbox.

We will create a `yarn` TypeScript project called `token` (although `npm` works fine too).

1. Initialize a yarn project

```sh
mkdir token
cd token
yarn init -yp
```

2. Create a `src` folder inside your new `token` directory:

```sh
mkdir src
```

3. Add necessary yarn packages

```sh
yarn add @aztec/aztec.js @aztec/accounts @aztec/noir-contracts.js typescript @types/node
```

4. Add a `tsconfig.json` file into the project root and paste this:

```json
{
  "compilerOptions": {
    "outDir": "dest",
    "rootDir": "src",
    "target": "es2020",
    "lib": ["dom", "esnext", "es2017.object"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "downlevelIteration": true,
    "inlineSourceMap": true,
    "declarationMap": true,
    "importHelpers": true,
    "resolveJsonModule": true,
    "composite": true,
    "skipLibCheck": true
  },
  "references": [],
  "include": ["src", "src/*.json"]
}
```

5. Add this to your `package.json`:

```json
  "type": "module",
  "scripts": {
    "build": "yarn clean && tsc -b",
    "build:dev": "tsc -b --watch",
    "clean": "rm -rf ./dest tsconfig.tsbuildinfo",
    "start": "yarn build && LOG_LEVEL='info: token' node ./dest/index.js"
  },
```

6. Create an `index.ts` file in the `src` directory with the following sandbox connection setup:

```ts
import { getSchnorrAccount } from '@aztec/accounts/schnorr';
import { getDeployedTestAccountsWallets } from '@aztec/accounts/testing';
import {
  getDeployedBananaCoinAddress,
  getDeployedBananaFPCAddress,
  getDeployedSponsoredFPCAddress,
} from '@aztec/aztec';
import {
  Fr,
  GrumpkinScalar,
  type PXE,
  PrivateFeePaymentMethod,
  createLogger,
  createPXEClient,
  getFeeJuiceBalance,
  waitForPXE,
} from '@aztec/aztec.js';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee/testing';
import { timesParallel } from '@aztec/foundation/collection';
import { TokenContract } from '@aztec/noir-contracts.js/Token';

import { format } from 'util';
import type { AztecAddress, Logger, Wallet } from '@aztec/aztec.js';
import { TokenContract } from '@aztec/noir-contracts.js/Token';

export async function deployToken(adminWallet: Wallet, initialAdminBalance: bigint, logger: Logger) {
  logger.info(`Deploying Token contract...`);
  const contract = await TokenContract.deploy(adminWallet, adminWallet.getAddress(), 'TokenName', 'TokenSymbol', 18)
    .send()
    .deployed();

  if (initialAdminBalance > 0n) {
    // Minter is minting to herself so contract as minter is the same as contract as recipient
    await mintTokensToPrivate(contract, adminWallet, adminWallet.getAddress(), initialAdminBalance);
  }

  logger.info('L2 contract deployed');

  return contract;
}

export async function mintTokensToPrivate(
  token: TokenContract,
  minterWallet: Wallet,
  recipient: AztecAddress,
  amount: bigint,
) {
  const tokenAsMinter = await TokenContract.at(token.address, minterWallet);
  const from = minterWallet.getAddress(); // we are setting from to minter here because we need a sender to calculate the tag
  await tokenAsMinter.methods.mint_to_private(from, recipient, amount).send().wait();
}

const { PXE_URL = 'http://localhost:8080' } = process.env;

async function main() {
////////////// CREATE THE CLIENT INTERFACE AND CONTACT THE SANDBOX //////////////
const logger = createLogger('e2e:token');

// We create PXE client connected to the sandbox URL
const pxe = createPXEClient(PXE_URL);
// Wait for sandbox to be ready
await waitForPXE(pxe, logger);

const nodeInfo = await pxe.getNodeInfo();

logger.info(format('Aztec Sandbox Info ', nodeInfo));
}

main();
```

7. Finally, run the package:

In the project root, run

```sh
yarn start
```

A successful run should show something like this:

```
  token Aztec Sandbox Info  {
  token   sandboxVersion: '0.82.2',
  token   chainId: 31337,
  token   protocolVersion: 1,
  token   l1ContractAddresses: {
  token     rollupAddress: EthAddress {
  token       buffer: <Buffer cf 7e d3 ac ca 5a 46 7e 9e 70 4c 70 3e 8d 87 f6 34 fb 0f c9>
  token     },
  token     registryAddress: EthAddress {
  token       buffer: <Buffer 5f bd b2 31 56 78 af ec b3 67 f0 32 d9 3f 64 2f 64 18 0a a3>
  token     },
  token     inboxAddress: EthAddress {
  token       buffer: <Buffer e7 f1 72 5e 77 34 ce 28 8f 83 67 e1 bb 14 3e 90 bb 3f 05 12>
  token     },
  token     outboxAddress: EthAddress {
  token       buffer: <Buffer 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00>
  token     },
  token   }
  token } +0ms
```

Great! The Sandbox is running and we are able to interact with it.

## Load accounts

The sandbox is preloaded with multiple accounts so you don't have to sit and create them. Let's load these accounts. Add this code to the `main()` function in `index.ts` below the code that's there:

```typescript title="load_accounts" showLineNumbers
////////////// LOAD SOME ACCOUNTS FROM THE SANDBOX //////////////
// The sandbox comes with a set of created accounts. Load them
const accounts = await getDeployedTestAccountsWallets(pxe);
const aliceWallet = accounts[0];
const bobWallet = accounts[1];
const alice = aliceWallet.getAddress();
const bob = bobWallet.getAddress();
logger.info(`Loaded alice's account at ${alice.toString()}`);
logger.info(`Loaded bob's account at ${bob.toString()}`);
```
> <sup><sub><a href="https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/end-to-end/src/composed/e2e_sandbox_example.test.ts#L106-L116" target="_blank" rel="noopener noreferrer">Source code: yarn-project/end-to-end/src/composed/e2e_sandbox_example.test.ts#L106-L116</a></sub></sup>


An explanation on accounts on Aztec can be found [here](../../../../aztec/concepts/accounts/index.md).

## Deploy a contract

Now that we have our accounts loaded, let's move on to deploy our pre-compiled token smart contract. You can find the full code for the contract [here (GitHub link)](https://github.com/AztecProtocol/aztec-packages/tree/master/noir-projects/noir-contracts/contracts/token_contract/src). Add this to `index.ts` below the code you added earlier:

```typescript title="Deployment" showLineNumbers
////////////// DEPLOY OUR TOKEN CONTRACT //////////////

const initialSupply = 1_000_000n;

const tokenContractAlice = await deployToken(aliceWallet, initialSupply, logger);
```
> <sup><sub><a href="https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/end-to-end/src/composed/e2e_sandbox_example.test.ts#L118-L124" target="_blank" rel="noopener noreferrer">Source code: yarn-project/end-to-end/src/composed/e2e_sandbox_example.test.ts#L118-L124</a></sub></sup>


`yarn start` will now give something like this:

```
  token Aztec Sandbox Info  {
  token   sandboxVersion: '0.82.2',
  token   chainId: 31337,
  token   protocolVersion: 1,
  token   l1ContractAddresses: {
  token     rollupAddress: EthAddress {
  token       buffer: <Buffer cf 7e d3 ac ca 5a 46 7e 9e 70 4c 70 3e 8d 87 f6 34 fb 0f c9>
  token     },
  token     registryAddress: EthAddress {
  token       buffer: <Buffer 5f bd b2 31 56 78 af ec b3 67 f0 32 d9 3f 64 2f 64 18 0a a3>
  token     },
  token     inboxAddress: EthAddress {
  token       buffer: <Buffer e7 f1 72 5e 77 34 ce 28 8f 83 67 e1 bb 14 3e 90 bb 3f 05 12>
  token     },
  token     outboxAddress: EthAddress {
  token       buffer: <Buffer 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00>
  token     },
  token   }
  token } +0ms
  token Loaded alice's account at 0x25048e8c...70d0 +4s
  token Loaded bob's account at 0x115f123b...6483 +0ms
  token Deploying token contract... +0ms
  token Contract successfully deployed at address 0x11a03dce...afc7 +5s
  token Minting tokens to Alice... +18ms
  token 1000000 tokens were successfully minted and redeemed by Alice +10s
```

We can break this down as follows:

1. We create and send a contract deployment transaction to the network.
2. We wait for it to be successfully mined.
3. We retrieve the transaction receipt containing the transaction status and contract address.
4. We connect to the contract with Alice
5. Alice initialize the contract with herself as the admin and a minter.
6. Alice privately mints 1,000,000 tokens to herself

## View the balance of an account

A token contract wouldn't be very useful if you aren't able to query the balance of an account. As part of the deployment, tokens were minted to Alice. We can now call the contract's `balance_of_private()` function to retrieve the balances of the accounts.

Call the `balance_of_private` function using the following code (paste this):

```typescript title="Balance" showLineNumbers

////////////// QUERYING THE TOKEN BALANCE FOR EACH ACCOUNT //////////////

// Bob wants to mint some funds, the contract is already deployed, create an abstraction and link it his wallet
// Since we already have a token link, we can simply create a new instance of the contract linked to Bob's wallet
const tokenContractBob = tokenContractAlice.withWallet(bobWallet);

let aliceBalance = await tokenContractAlice.methods.balance_of_private(alice).simulate();
logger.info(`Alice's balance ${aliceBalance}`);

let bobBalance = await tokenContractBob.methods.balance_of_private(bob).simulate();
logger.info(`Bob's balance ${bobBalance}`);
```
> <sup><sub><a href="https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/end-to-end/src/composed/e2e_sandbox_example.test.ts#L129-L143" target="_blank" rel="noopener noreferrer">Source code: yarn-project/end-to-end/src/composed/e2e_sandbox_example.test.ts#L129-L143</a></sub></sup>


Running now should yield output:

```
  token Aztec Sandbox Info  {
  token   sandboxVersion: '0.82.2',
  token   chainId: 31337,
  token   protocolVersion: 1,
  token   l1ContractAddresses: {
  token     rollupAddress: EthAddress {
  token       buffer: <Buffer cf 7e d3 ac ca 5a 46 7e 9e 70 4c 70 3e 8d 87 f6 34 fb 0f c9>
  token     },
  token     registryAddress: EthAddress {
  token       buffer: <Buffer 5f bd b2 31 56 78 af ec b3 67 f0 32 d9 3f 64 2f 64 18 0a a3>
  token     },
  token     inboxAddress: EthAddress {
  token       buffer: <Buffer e7 f1 72 5e 77 34 ce 28 8f 83 67 e1 bb 14 3e 90 bb 3f 05 12>
  token     },
  token     outboxAddress: EthAddress {
  token       buffer: <Buffer 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00>
  token     },
  token   }
  token } +0ms
  token Loaded alice's account at 0x25048e8c...70d0 +4s
  token Loaded bob's account at 0x115f123b...6483 +0ms
  token Deploying token contract... +0ms
  token Contract successfully deployed at address 0x1b388d99...4b55 +4s
  token Minting tokens to Alice... +10ms
  token 1000000 tokens were successfully minted and redeemed by Alice +10s
  token Alice's balance 1000000 +80ms
  token Bob's balance 0 +31ms
```

Above, we created a second instance of the `TokenContract` contract class.
This time pertaining to Bob.
This class offers a TypeScript bindings of our `Token` contract..
We then call `balance_of_private()` as a `view` method.
View methods can be thought as read-only.
No transaction is submitted as a result but a user's state can be queried.

We can see that each account has the expected balance of tokens.

### Calling an unconstrained (view) function

<a href="https://raw.githubusercontent.com/AztecProtocol/aztec-packages/6b9e2cc6d13051c4ed38387264600a3cc6d28210/docs/static/img/sandbox_unconstrained_function.png"><img src="@site/static/img/sandbox_unconstrained_function.png" alt="Unconstrained function call" /></a>

## Create and submit a transaction

### Transfer

Now lets transfer some funds from Alice to Bob by calling the `transfer` function on the contract. This function takes 2 arguments:

1. The recipient.
2. The quantity of tokens to be transferred.

Here is the Typescript code to call the `transfer` function, add this to your `index.ts` at the bottom of the `main` function:

```typescript title="Transfer" showLineNumbers
////////////// TRANSFER FUNDS FROM ALICE TO BOB //////////////

// We will now transfer tokens from ALice to Bob
const transferQuantity = 543n;
logger.info(`Transferring ${transferQuantity} tokens from Alice to Bob...`);
await tokenContractAlice.methods.transfer(bob, transferQuantity).send().wait();

// Check the new balances
aliceBalance = await tokenContractAlice.methods.balance_of_private(alice).simulate();
logger.info(`Alice's balance ${aliceBalance}`);

bobBalance = await tokenContractBob.methods.balance_of_private(bob).simulate();
logger.info(`Bob's balance ${bobBalance}`);
```
> <sup><sub><a href="https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/end-to-end/src/composed/e2e_sandbox_example.test.ts#L148-L162" target="_blank" rel="noopener noreferrer">Source code: yarn-project/end-to-end/src/composed/e2e_sandbox_example.test.ts#L148-L162</a></sub></sup>


Our output should now look like this:

```
  token Aztec Sandbox Info  {
  token   sandboxVersion: '0.82.2',
  token   chainId: 31337,
  token   protocolVersion: 1,
  token   l1ContractAddresses: {
  token     rollupAddress: EthAddress {
  token       buffer: <Buffer cf 7e d3 ac ca 5a 46 7e 9e 70 4c 70 3e 8d 87 f6 34 fb 0f c9>
  token     },
  token     registryAddress: EthAddress {
  token       buffer: <Buffer 5f bd b2 31 56 78 af ec b3 67 f0 32 d9 3f 64 2f 64 18 0a a3>
  token     },
  token     inboxAddress: EthAddress {
  token       buffer: <Buffer e7 f1 72 5e 77 34 ce 28 8f 83 67 e1 bb 14 3e 90 bb 3f 05 12>
  token     },
  token     outboxAddress: EthAddress {
  token       buffer: <Buffer 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00>
  token     },
  token   }
  token } +0ms
  token Loaded alice's account at 0x25048e8c...70d0 +4s
  token Loaded bob's account at 0x115f123b...6483 +0ms
  token Deploying token contract... +0ms
  token Contract successfully deployed at address 0x01d8af7d...9a4d +5s
  token Minting tokens to Alice... +18ms
  token 1000000 tokens were successfully minted and redeemed by Alice +11s
  token Alice's balance 1000000 +59ms
  token Bob's balance 0 +33ms
  token Transferring 543 tokens from Alice to Bob... +0ms
  token Alice's balance 999457 +6s
  token Bob's balance 543 +39ms
```

Here, we used the same contract abstraction as was previously used for reading Alice's balance. But this time we called `send()` generating and sending a transaction to the network. After waiting for the transaction to settle we were able to check the new balance values.

### Mint

Finally, the contract has several `mint` functions that can be used to generate new tokens for an account.
We will focus only on `mint_to_private`.
This function has private and public execution components, but it mints tokens privately.
This function takes:

1. A minter (`from`)
2. A recipient
3. An amount of tokens to mint

This function starts as private to set up the creation of a [partial note](../../../../aztec/concepts/advanced/storage/partial_notes.md). The private function calls a public function that checks that the minter is authorized to mint new tokens an increments the public total supply. The recipient of the tokens remains private, but the minter and the amount of tokens minted are public.

Let's now use these functions to mint some tokens to Bob's account using Typescript, add this to `index.ts`:

```typescript title="Mint" showLineNumbers
////////////// MINT SOME MORE TOKENS TO BOB'S ACCOUNT //////////////

// Now mint some further funds for Bob

// Alice is nice and she adds Bob as a minter
await tokenContractAlice.methods.set_minter(bob, true).send().wait();

const mintQuantity = 10_000n;
await mintTokensToPrivate(tokenContractBob, bobWallet, bob, mintQuantity);

// Check the new balances
aliceBalance = await tokenContractAlice.methods.balance_of_private(alice).simulate();
logger.info(`Alice's balance ${aliceBalance}`);

bobBalance = await tokenContractBob.methods.balance_of_private(bob).simulate();
logger.info(`Bob's balance ${bobBalance}`);
```
> <sup><sub><a href="https://github.com/AztecProtocol/aztec-packages/blob/master/yarn-project/end-to-end/src/composed/e2e_sandbox_example.test.ts#L167-L184" target="_blank" rel="noopener noreferrer">Source code: yarn-project/end-to-end/src/composed/e2e_sandbox_example.test.ts#L167-L184</a></sub></sup>


Our complete output should now be something like:

```
  token Aztec Sandbox Info  {
  token   sandboxVersion: '0.82.2',
  token   chainId: 31337,
  token   protocolVersion: 1,
  token   l1ContractAddresses: {
  token     rollupAddress: EthAddress {
  token       buffer: <Buffer cf 7e d3 ac ca 5a 46 7e 9e 70 4c 70 3e 8d 87 f6 34 fb 0f c9>
  token     },
  token     registryAddress: EthAddress {
  token       buffer: <Buffer 5f bd b2 31 56 78 af ec b3 67 f0 32 d9 3f 64 2f 64 18 0a a3>
  token     },
  token     inboxAddress: EthAddress {
  token       buffer: <Buffer e7 f1 72 5e 77 34 ce 28 8f 83 67 e1 bb 14 3e 90 bb 3f 05 12>
  token     },
  token     outboxAddress: EthAddress {
  token       buffer: <Buffer 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00>
  token     },
  token   }
  token } +0ms
  token Loaded alice's account at 0x25048e8c...70d0 +4s
  token Loaded bob's account at 0x115f123b...6483 +0ms
  token Deploying token contract... +0ms
  token Contract successfully deployed at address 0x03a0bb2c...02c2 +7s
  token Minting tokens to Alice... +19ms
  token 1000000 tokens were successfully minted and redeemed by Alice +9s
  token Alice's balance 1000000 +43ms
  token Bob's balance 0 +31ms
  token Transferring 543 tokens from Alice to Bob... +0ms
  token Alice's balance 999457 +6s
  token Bob's balance 543 +36ms
  token Minting 10000 tokens to Bob... +5s
  token Alice's balance 999457 +9s
  token Bob's balance 10543 +43ms
```

That's it! We have successfully deployed a token contract to an instance of the Aztec network and mined private state-transitioning transactions. We have also queried the resulting state all via the interfaces provided by the contract. To see exactly what has happened here, you can learn about the transaction flow [on the Concepts page here](../../../../aztec/concepts/transactions.md).

## Next Steps

### Build a fullstack Aztec project

Follow the [dapp tutorial](./simple_dapp/index.md).

### Optional: Learn more about concepts mentioned here

- [Authentication witness](../../../../aztec/concepts/advanced/authwit.md)
- [Functions under the hood](../../../../aztec/smart_contracts/functions/function_transforms.md)
