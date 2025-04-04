import type { AztecNodeService } from '@aztec/aztec-node';
import { sleep } from '@aztec/aztec.js';
import { RollupContract } from '@aztec/ethereum';
import { jsonStringify } from '@aztec/foundation/json-rpc';
import { RollupAbi, SlashFactoryAbi, SlasherAbi, SlashingProposerAbi } from '@aztec/l1-artifacts';

import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAddress, getContract, parseEventLogs } from 'viem';

import { shouldCollectMetrics } from '../fixtures/fixtures.js';
import { createNodes } from '../fixtures/setup_p2p_test.js';
import { P2PNetworkTest } from './p2p_network.js';

jest.setTimeout(1000000);

// Don't set this to a higher value than 9 because each node will use a different L1 publisher account and anvil seeds
const NUM_NODES = 4;
const BOOT_NODE_UDP_PORT = 40600;

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slashing-'));

// This test is showcasing that slashing can happen, abusing that our nodes are honest but stupid
// making them slash themselves.
describe('e2e_p2p_slashing', () => {
  let t: P2PNetworkTest;
  let nodes: AztecNodeService[];

  const slashingQuorum = 6;
  const slashingRoundSize = 10;

  beforeEach(async () => {
    t = await P2PNetworkTest.create({
      testName: 'e2e_p2p_slashing',
      numberOfNodes: NUM_NODES,
      basePort: BOOT_NODE_UDP_PORT,
      metricsPort: shouldCollectMetrics(),
      initialConfig: {
        listenAddress: '127.0.0.1',
        aztecEpochDuration: 1,
        ethereumSlotDuration: 4,
        aztecSlotDuration: 12,
        aztecProofSubmissionWindow: 1,
        slashingQuorum,
        slashingRoundSize,
      },
    });

    await t.setupAccount();
    await t.applyBaseSnapshots();
    await t.setup();
    await t.removeInitialNode();
  });

  afterEach(async () => {
    await t.stopNodes(nodes);
    await t.teardown();
    for (let i = 0; i < NUM_NODES; i++) {
      fs.rmSync(`${DATA_DIR}-${i}`, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it('should slash the attesters', async () => {
    // create the bootstrap node for the network
    if (!t.bootstrapNodeEnr) {
      throw new Error('Bootstrap node ENR is not available');
    }

    const rollup = new RollupContract(
      t.ctx.deployL1ContractsValues!.publicClient,
      t.ctx.deployL1ContractsValues!.l1ContractAddresses.rollupAddress,
    );

    const slasherContract = getContract({
      address: getAddress(await rollup.getSlasher()),
      abi: SlasherAbi,
      client: t.ctx.deployL1ContractsValues.publicClient,
    });

    const slashingProposer = getContract({
      address: getAddress(await slasherContract.read.PROPOSER()),
      abi: SlashingProposerAbi,
      client: t.ctx.deployL1ContractsValues.publicClient,
    });

    const slashFactory = getContract({
      address: getAddress(t.ctx.deployL1ContractsValues.l1ContractAddresses.slashFactoryAddress!.toString()),
      abi: SlashFactoryAbi,
      client: t.ctx.deployL1ContractsValues.publicClient,
    });

    const slashingInfo = async () => {
      const bn = await t.ctx.cheatCodes.eth.blockNumber();
      const slotNumber = await rollup.getSlotNumber();
      const roundNumber = await slashingProposer.read.computeRound([slotNumber]);
      const instanceAddress = t.ctx.deployL1ContractsValues.l1ContractAddresses.rollupAddress.toString();
      const info = await slashingProposer.read.rounds([instanceAddress, roundNumber]);
      const leaderVotes = await slashingProposer.read.yeaCount([instanceAddress, roundNumber, info[1]]);
      return { bn, slotNumber, roundNumber, info, leaderVotes };
    };

    const waitUntilNextRound = async () => {
      t.logger.info(`Waiting for next round`);
      const roundSize = await slashingProposer.read.M();
      const currentRound = (await rollup.getSlotNumber()) / roundSize;
      const nextRoundSlot = currentRound * roundSize + roundSize;
      while ((await rollup.getSlotNumber()) < nextRoundSlot) {
        await sleep(1000);
      }
    };

    t.ctx.aztecNodeConfig.validatorReexecute = false;
    t.ctx.aztecNodeConfig.minTxsPerBlock = 0;

    // create our network of nodes and submit txs into each of them
    // the number of txs per node and the number of txs per rollup
    // should be set so that the only way for rollups to be built
    // is if the txs are successfully gossiped around the nodes.
    t.logger.info('Creating nodes');
    nodes = await createNodes(
      t.ctx.aztecNodeConfig,
      t.ctx.dateProvider,
      t.bootstrapNodeEnr,
      NUM_NODES,
      BOOT_NODE_UDP_PORT,
      t.prefilledPublicData,
      DATA_DIR,
      // To collect metrics - run in aztec-packages `docker compose --profile metrics up` and set COLLECT_METRICS=true
      shouldCollectMetrics(),
    );

    // We are overriding the slashing amount to 1, such that the slashing will "really" happen.
    for (const node of nodes) {
      const seqClient = node.getSequencer();
      if (!seqClient) {
        throw new Error('Sequencer not found');
      }
      const sequencer = (seqClient as any).sequencer;
      const slasher = (sequencer as any).slasherClient;
      slasher.slashingAmount = 1n;
    }

    // wait a bit for peers to discover each other
    await sleep(4000);

    let sInfo = await slashingInfo();

    const votesNeeded = await slashingProposer.read.N();

    // Produce blocks until we hit an issue with pruning.
    // Then we should jump in time to the next round so we are sure that we have the votes
    // Then we just sit on our hands and wait.

    const seqClient = nodes[0].getSequencer();
    if (!seqClient) {
      throw new Error('Sequencer not found');
    }
    const sequencer = (seqClient as any).sequencer;
    const slasher = (sequencer as any).slasherClient;
    let slashEvents: any[] = [];

    t.logger.info(`Producing blocks until we hit a pruning event`);

    // Run for up to the slashing round size, or as long as needed to get a slash event
    // Variable because sometimes hit race-condition issues with attestations.
    for (let i = 0; i < slashingRoundSize; i++) {
      const bn = await nodes[0].getBlockNumber();

      t.logger.info(`Waiting for block number to change`);
      while (bn === (await nodes[0].getBlockNumber())) {
        await sleep(1000);
      }

      // Create a clone of slasher.slashEvents to prevent race conditions
      // The validator client can remove elements from the original array
      slashEvents = [...slasher.slashEvents];
      t.logger.info(`Slash events: ${slashEvents.length}`);
      t.logger.info(`Slash events: ${jsonStringify(slashEvents)}`);
      if (slashEvents.length > 0) {
        t.logger.info(`We have a slash event ${i}`);
        break;
      }
    }

    expect(slashEvents.length).toBeGreaterThan(0);
    await waitUntilNextRound();

    // For the next round we will try to cast votes.
    // Stop early if we have enough votes.
    t.logger.info(`Waiting for votes to be cast`);
    for (let i = 0; i < slashingRoundSize; i++) {
      t.logger.info(`Waiting for block number to change`);
      const slotNumber = await rollup.getSlotNumber();
      while (slotNumber === (await rollup.getSlotNumber())) {
        await sleep(1000);
      }

      sInfo = await slashingInfo();
      t.logger.info(`We have ${sInfo.leaderVotes} votes in round ${sInfo.roundNumber} on ${sInfo.info[1]}`);
      if (sInfo.leaderVotes > votesNeeded) {
        t.logger.info(`We have sufficient votes`);
        break;
      }
    }

    t.logger.info('Deploy the actual payload for slashing!');
    const slashEvent = slashEvents[0];
    await t.ctx.deployL1ContractsValues.publicClient.waitForTransactionReceipt({
      hash: await slashFactory.write.createSlashPayload([slashEvent.epoch, slashEvent.amount], {
        account: t.ctx.deployL1ContractsValues.walletClient.account,
      }),
    });

    t.logger.info(`We jump in time to the next round to execute`);
    await waitUntilNextRound();
    const attestersPre = await rollup.getAttesters();

    for (const attester of attestersPre) {
      const attesterInfo = await rollup.getInfo(attester);
      // Check that status isValidating
      expect(attesterInfo.status).toEqual(1);
    }

    t.logger.info(`Push the proposal, SLASHING!`);
    const tx = await slashingProposer.write.executeProposal([sInfo.roundNumber], {
      account: t.ctx.deployL1ContractsValues.walletClient.account,
    });
    const receipt = await t.ctx.deployL1ContractsValues.publicClient.waitForTransactionReceipt({
      hash: tx,
    });

    const slashingEvents = parseEventLogs({
      abi: RollupAbi,
      logs: receipt.logs,
    }).filter(log => log.eventName === 'Slashed');

    const attestersSlashed = slashingEvents.map(event => {
      // Because TS is a little nagging bitch
      return (event.args as any).attester;
    });

    // Convert attestersPre elements to lowercase for consistent comparison
    const normalizedAttestersPre = attestersPre.map(addr => addr.toLowerCase());
    const normalizedAttestersSlashed = attestersSlashed.map(addr => addr.toLowerCase());
    expect(new Set(normalizedAttestersPre)).toEqual(new Set(normalizedAttestersSlashed));

    const instanceAddress = t.ctx.deployL1ContractsValues.l1ContractAddresses.rollupAddress.toString();
    const infoPost = await slashingProposer.read.rounds([instanceAddress, sInfo.roundNumber]);

    expect(sInfo.info[1]).toEqual(infoPost[1]);
    expect(sInfo.info[2]).toEqual(false);
    expect(infoPost[2]).toEqual(true);

    const attestersPost = await rollup.getAttesters();

    for (const attester of attestersPre) {
      const attesterInfo = await rollup.getInfo(attester);
      // Check that status is Living
      expect(attesterInfo.status).toEqual(2);
    }
    const committee = await rollup.getEpochCommittee(slashEvent.epoch);
    expect(attestersPre.length).toBe(committee.length);
    expect(attestersPost.length).toBe(0);
  }, 1_000_000);
});
