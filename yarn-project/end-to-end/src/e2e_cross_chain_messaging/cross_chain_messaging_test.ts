import { getSchnorrWallet } from '@aztec/accounts/schnorr';
import type { AztecNodeConfig } from '@aztec/aztec-node';
import {
  type AccountWallet,
  AztecAddress,
  type AztecNode,
  type CompleteAddress,
  EthAddress,
  type Logger,
  type PXE,
  createLogger,
} from '@aztec/aztec.js';
import { CheatCodes } from '@aztec/aztec.js/testing';
import { type ViemPublicClient, createL1Clients, deployL1Contract } from '@aztec/ethereum';
import { InboxAbi, OutboxAbi, TestERC20Abi, TestERC20Bytecode } from '@aztec/l1-artifacts';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge';

import { getContract } from 'viem';

import { MNEMONIC } from '../fixtures/fixtures.js';
import {
  type ISnapshotManager,
  type SubsystemsContext,
  createSnapshotManager,
  deployAccounts,
  publicDeployAccounts,
} from '../fixtures/snapshot_manager.js';
import { CrossChainTestHarness } from '../shared/cross_chain_test_harness.js';

const { E2E_DATA_PATH: dataPath } = process.env;

export class CrossChainMessagingTest {
  private snapshotManager: ISnapshotManager;
  logger: Logger;
  wallets: AccountWallet[] = [];
  accounts: CompleteAddress[] = [];
  aztecNode!: AztecNode;
  pxe!: PXE;
  aztecNodeConfig!: AztecNodeConfig;

  publicClient!: ViemPublicClient | undefined;

  user1Wallet!: AccountWallet;
  user2Wallet!: AccountWallet;
  crossChainTestHarness!: CrossChainTestHarness;
  ethAccount!: EthAddress;
  ownerAddress!: AztecAddress;
  l2Token!: TokenContract;
  l2Bridge!: TokenBridgeContract;

  inbox!: any; // GetContractReturnType<typeof InboxAbi> | undefined;
  outbox!: any; // GetContractReturnType<typeof OutboxAbi> | undefined;
  cheatcodes!: CheatCodes;

  constructor(testName: string) {
    this.logger = createLogger(`e2e:e2e_cross_chain_messaging:${testName}`);
    this.snapshotManager = createSnapshotManager(`e2e_cross_chain_messaging/${testName}`, dataPath);
  }

  async assumeProven() {
    await this.cheatcodes.rollup.markAsProven();
  }

  async setup() {
    const { aztecNode, pxe, aztecNodeConfig } = await this.snapshotManager.setup();
    this.aztecNode = aztecNode;
    this.pxe = pxe;
    this.aztecNodeConfig = aztecNodeConfig;
    this.cheatcodes = await CheatCodes.create(this.aztecNodeConfig.l1RpcUrls, this.pxe);
  }

  snapshot = <T>(
    name: string,
    apply: (context: SubsystemsContext) => Promise<T>,
    restore: (snapshotData: T, context: SubsystemsContext) => Promise<void> = () => Promise.resolve(),
  ): Promise<void> => this.snapshotManager.snapshot(name, apply, restore);

  async teardown() {
    await this.snapshotManager.teardown();
  }

  async applyBaseSnapshots() {
    // Note that we are using the same `pxe`, `aztecNodeConfig` and `aztecNode` across all snapshots.
    // This is to not have issues with different networks.

    await this.snapshotManager.snapshot(
      '3_accounts',
      deployAccounts(3, this.logger),
      async ({ deployedAccounts }, { pxe, aztecNodeConfig, aztecNode }) => {
        this.wallets = await Promise.all(deployedAccounts.map(a => getSchnorrWallet(pxe, a.address, a.signingKey)));
        this.accounts = this.wallets.map(w => w.getCompleteAddress());
        this.wallets.forEach((w, i) => this.logger.verbose(`Wallet ${i} address: ${w.getAddress()}`));

        this.user1Wallet = this.wallets[0];
        this.user2Wallet = this.wallets[1];

        this.pxe = pxe;
        this.aztecNode = aztecNode;
        this.aztecNodeConfig = aztecNodeConfig;
      },
    );

    await this.snapshotManager.snapshot(
      'e2e_cross_chain_messaging',
      async () => {
        // Create the token contract state.
        // Move this account thing to addAccounts above?
        this.logger.verbose(`Public deploy accounts...`);
        await publicDeployAccounts(this.wallets[0], this.accounts.slice(0, 3));

        const { publicClient, walletClient } = createL1Clients(this.aztecNodeConfig.l1RpcUrls, MNEMONIC);

        const underlyingERC20Address = await deployL1Contract(
          walletClient,
          publicClient,
          TestERC20Abi,
          TestERC20Bytecode,
          ['Underlying', 'UND', walletClient.account.address],
        ).then(({ address }) => address);

        this.logger.verbose(`Setting up cross chain harness...`);
        this.crossChainTestHarness = await CrossChainTestHarness.new(
          this.aztecNode,
          this.pxe,
          publicClient,
          walletClient,
          this.wallets[0],
          this.logger,
          underlyingERC20Address,
        );

        this.logger.verbose(`L2 token deployed to: ${this.crossChainTestHarness.l2Token.address}`);

        return this.crossChainTestHarness.toCrossChainContext();
      },
      async crossChainContext => {
        this.l2Token = await TokenContract.at(crossChainContext.l2Token, this.user1Wallet);
        this.l2Bridge = await TokenBridgeContract.at(crossChainContext.l2Bridge, this.user1Wallet);

        // There is an issue with the reviver so we are getting strings sometimes. Working around it here.
        this.ethAccount = EthAddress.fromString(crossChainContext.ethAccount.toString());
        this.ownerAddress = AztecAddress.fromString(crossChainContext.ownerAddress.toString());
        const tokenPortalAddress = EthAddress.fromString(crossChainContext.tokenPortal.toString());

        const { publicClient, walletClient } = createL1Clients(this.aztecNodeConfig.l1RpcUrls, MNEMONIC);

        const inbox = getContract({
          address: this.aztecNodeConfig.l1Contracts.inboxAddress.toString(),
          abi: InboxAbi,
          client: walletClient,
        });
        const outbox = getContract({
          address: this.aztecNodeConfig.l1Contracts.outboxAddress.toString(),
          abi: OutboxAbi,
          client: walletClient,
        });

        this.crossChainTestHarness = new CrossChainTestHarness(
          this.aztecNode,
          this.pxe,
          this.logger,
          this.l2Token,
          this.l2Bridge,
          this.ethAccount,
          tokenPortalAddress,
          crossChainContext.underlying,
          publicClient,
          walletClient,
          this.aztecNodeConfig.l1Contracts,
          this.user1Wallet,
        );

        this.publicClient = publicClient;
        this.inbox = inbox;
        this.outbox = outbox;
      },
    );
  }
}
