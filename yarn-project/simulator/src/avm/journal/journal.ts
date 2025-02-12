import { type IndexedTreeId, MerkleTreeId, type MerkleTreeWriteOperations } from '@aztec/circuit-types';
import {
  AztecAddress,
  CANONICAL_AUTH_REGISTRY_ADDRESS,
  DEPLOYER_CONTRACT_ADDRESS,
  FEE_JUICE_ADDRESS,
  MULTI_CALL_ENTRYPOINT_ADDRESS,
  NullifierLeafPreimage,
  type PublicCallRequest,
  type PublicDataTreeLeafPreimage,
  PublicDataWrite,
  REGISTERER_CONTRACT_ADDRESS,
  ROUTER_ADDRESS,
  SerializableContractInstance,
} from '@aztec/circuits.js';
import {
  computeNoteHashNonce,
  computePublicDataTreeLeafSlot,
  computeUniqueNoteHash,
  siloNoteHash,
  siloNullifier,
} from '@aztec/circuits.js/hash';
import { Fr } from '@aztec/foundation/fields';
import { jsonStringify } from '@aztec/foundation/json-rpc';
import { createLogger } from '@aztec/foundation/log';
import { type IndexedTreeLeafPreimage } from '@aztec/foundation/trees';

import { strict as assert } from 'assert';
import cloneDeep from 'lodash.clonedeep';

import { getPublicFunctionDebugName } from '../../common/debug_fn_name.js';
import { type WorldStateDB } from '../../public/public_db_sources.js';
import { type PublicSideEffectTraceInterface } from '../../public/side_effect_trace_interface.js';
import { type AvmExecutionEnvironment } from '../avm_execution_environment.js';
import { AvmEphemeralForest } from '../avm_tree.js';
import { NullifierCollisionError, NullifierManager } from './nullifiers.js';
import { PublicStorage } from './public_storage.js';

/**
 * The result of fetching a leaf from an indexed tree. Contains the preimage and wether the leaf was already present
 * or it's a low leaf.
 */
type GetLeafResult<T extends IndexedTreeLeafPreimage> = {
  preimage: T;
  leafIndex: bigint;
  alreadyPresent: boolean;
};

/**
 * A class to manage persistable AVM state for contract calls.
 * Maintains a cache of the current world state,
 * a trace of all side effects.
 *
 * The simulator should make any world state / tree queries through this object.
 *
 * Manages merging of successful/reverted child state into current state.
 */
export class AvmPersistableStateManager {
  private readonly log = createLogger('simulator:avm:state_manager');

  /** Make sure a forked state is never merged twice. */
  private alreadyMergedIntoParent = false;

  private readonly db: MerkleTreeWriteOperations;

  constructor(
    /** Reference to node storage */
    private readonly worldStateDB: WorldStateDB,
    /** Side effect trace */
    // TODO(5818): make private once no longer accessed in executor
    public readonly trace: PublicSideEffectTraceInterface,
    /** Public storage, including cached writes */
    private readonly publicStorage: PublicStorage = new PublicStorage(worldStateDB),
    /** Nullifier set, including cached/recently-emitted nullifiers */
    private readonly nullifiers: NullifierManager = new NullifierManager(worldStateDB),
    private readonly doMerkleOperations: boolean = false,
    /** Ephmeral forest for merkle tree operations */
    public merkleTrees: AvmEphemeralForest,
    public readonly firstNullifier: Fr,
  ) {
    this.db = worldStateDB.getMerkleInterface();
  }

  /**
   * Create a new state manager
   */
  public static async create(
    worldStateDB: WorldStateDB,
    trace: PublicSideEffectTraceInterface,
    doMerkleOperations: boolean = false,
    firstNullifier: Fr,
  ): Promise<AvmPersistableStateManager> {
    const ephemeralForest = await AvmEphemeralForest.create(worldStateDB.getMerkleInterface());
    return new AvmPersistableStateManager(
      worldStateDB,
      trace,
      /*publicStorage=*/ new PublicStorage(worldStateDB),
      /*nullifiers=*/ new NullifierManager(worldStateDB),
      /*doMerkleOperations=*/ doMerkleOperations,
      ephemeralForest,
      firstNullifier,
    );
  }

  public async getTreeInfo(treeId: MerkleTreeId) {
    return await this.db.getTreeInfo(treeId);
  }

  /**
   * Create a new state manager forked from this one
   */
  public async fork() {
    await this.worldStateDB.createCheckpoint();
    return new AvmPersistableStateManager(
      this.worldStateDB,
      this.trace.fork(),
      this.publicStorage.fork(),
      this.nullifiers.fork(),
      this.doMerkleOperations,
      this.merkleTrees.fork(),
      this.firstNullifier,
    );
  }

  /**
   * Accept forked world state modifications & traced side effects / hints
   */
  public async merge(forkedState: AvmPersistableStateManager) {
    await this._merge(forkedState, /*reverted=*/ false);
  }

  /**
   * Reject forked world state modifications & traced side effects, keep traced hints
   */
  public async reject(forkedState: AvmPersistableStateManager) {
    await this._merge(forkedState, /*reverted=*/ true);
  }

  private async _merge(forkedState: AvmPersistableStateManager, reverted: boolean) {
    // sanity check to avoid merging the same forked trace twice
    assert(
      !forkedState.alreadyMergedIntoParent,
      'Cannot merge forked state that has already been merged into its parent!',
    );
    forkedState.alreadyMergedIntoParent = true;
    this.publicStorage.acceptAndMerge(forkedState.publicStorage);
    this.nullifiers.acceptAndMerge(forkedState.nullifiers);
    this.trace.merge(forkedState.trace, reverted);
    if (reverted) {
      await this.worldStateDB.revertCheckpoint();
      if (this.doMerkleOperations) {
        this.log.trace(
          `Rolled back nullifier tree to root ${new Fr((await this.db.getTreeInfo(MerkleTreeId.NULLIFIER_TREE)).root)}`,
          //`Rolled back nullifier tree to root ${this.merkleTrees.treeMap.get(MerkleTreeId.NULLIFIER_TREE)!.getRoot()}`,
        );
      }
    } else {
      this.log.trace('Merging forked state into parent...');
      await this.worldStateDB.commitCheckpoint();
      this.merkleTrees = forkedState.merkleTrees;
    }
  }

  /**
   * Write to public storage, journal/trace the write.
   *
   * @param contractAddress - the address of the contract whose storage is being written to
   * @param slot - the slot in the contract's storage being written to
   * @param value - the value being written to the slot
   */
  public async writeStorage(contractAddress: AztecAddress, slot: Fr, value: Fr, protocolWrite = false): Promise<void> {
    this.log.trace(`Storage write (address=${contractAddress}, slot=${slot}): value=${value}`);
    const leafSlot = await computePublicDataTreeLeafSlot(contractAddress, slot);
    this.log.trace(`leafSlot=${leafSlot}`);
    // Cache storage writes for later reference/reads
    this.publicStorage.write(contractAddress, slot, value);

    if (this.doMerkleOperations) {
      // write to native merkle trees
      const publicDataWrite = new PublicDataWrite(leafSlot, value);
      const result = await this.db.sequentialInsert(MerkleTreeId.PUBLIC_DATA_TREE, [publicDataWrite.toBuffer()]);
      //const result = await this.merkleTrees.writePublicStorage(leafSlot, value);
      assert(result !== undefined, 'Public data tree insertion error. You might want to disable doMerkleOperations.');
      this.log.trace(`Inserted public data tree leaf at leafSlot ${leafSlot}, value: ${value}`);

      // low leaf hint
      const lowLeafPreimage = result.lowLeavesWitnessData[0].leafPreimage as PublicDataTreeLeafPreimage;
      const lowLeafIndex = result.lowLeavesWitnessData[0].index;
      const lowLeafPath = result.lowLeavesWitnessData[0].siblingPath.toFields();
      // new leaf insertion
      // TODO: is this right?
      let newLeafPreimage: PublicDataTreeLeafPreimage = lowLeafPreimage;
      let insertionPath: Fr[] | undefined;

      //result.insertionWitnessData
      //result.lowLeavesWitnessData

      //const lowLeafInfo = result.lowWitness;
      //const lowLeafPreimage = result.lowWitness.preimage as PublicDataTreeLeafPreimage;
      //const lowLeafIndex = lowLeafInfo.index;
      //const lowLeafPath = lowLeafInfo.siblingPath;

      //const newLeafPreimage = result.element as PublicDataTreeLeafPreimage;
      //let insertionPath: Fr[] | undefined;
      //if (!result.update) {
      if (result.insertionWitnessData.length === 0) {
        // TODO: confirm that lowLeaf above is really lowLeaf or leaf-to-update
        assert(
          newLeafPreimage.value.equals(value),
          `Value mismatch when performing public data write (got value: ${value}, value in tree: ${newLeafPreimage.value})`,
        );
      } else {
        this.log.debug(`insertion witness data length: ${result.insertionWitnessData.length}`);
        // FIXME: this is wrong
        //newLeafPreimage = result.insertionWitnessData[0].leafPreimage as PublicDataTreeLeafPreimage;
        // TODO: is this necessary?! Why doesn't sequentialInsert return the newLeafPreimage?
        newLeafPreimage = cloneDeep(lowLeafPreimage);
        newLeafPreimage.slot = leafSlot;
        newLeafPreimage.value = value;
        this.log.debug(
          `newLeafPreimage.slot: ${newLeafPreimage.slot}, newLeafPreimage.value: ${newLeafPreimage.value}`,
        );
        this.log.debug(`insertion index: ${result.insertionWitnessData[0].index}`);
        insertionPath = result.insertionWitnessData[0].siblingPath.toFields();
      }

      await this.trace.tracePublicStorageWrite(
        contractAddress,
        slot,
        value,
        protocolWrite,
        lowLeafPreimage,
        new Fr(lowLeafIndex),
        lowLeafPath,
        newLeafPreimage,
        insertionPath,
      );
    } else {
      await this.trace.tracePublicStorageWrite(contractAddress, slot, value, protocolWrite);
    }
  }

  /**
   * Read from public storage, trace the read.
   *
   * @param contractAddress - the address of the contract whose storage is being read from
   * @param slot - the slot in the contract's storage being read from
   * @returns the latest value written to slot, or 0 if never written to before
   */
  public async readStorage(contractAddress: AztecAddress, slot: Fr): Promise<Fr> {
    const { value, cached } = await this.publicStorage.read(contractAddress, slot);
    this.log.trace(`Storage read  (address=${contractAddress}, slot=${slot}): value=${value}, cached=${cached}`);
    const leafSlot = await computePublicDataTreeLeafSlot(contractAddress, slot);
    this.log.trace(`leafSlot=${leafSlot}`);

    if (this.doMerkleOperations) {
      // Get leaf if present, low leaf if absent
      // If leaf is present, hint/trace it. Otherwise, hint/trace the low leaf.
      const { preimage, leafIndex, alreadyPresent } = await this.getLeafOrLowLeafInfo(
        MerkleTreeId.PUBLIC_DATA_TREE,
        leafSlot.toBigInt(),
      );
      const siblingPath = await this.db.getSiblingPath(MerkleTreeId.PUBLIC_DATA_TREE, leafIndex);
      //const {
      //  preimage,
      //  index: leafIndex,
      //  alreadyPresent,
      //} = await this.merkleTrees.getLeafOrLowLeafInfo(MerkleTreeId.PUBLIC_DATA_TREE, leafSlot);
      // The index and preimage here is either the low leaf or the leaf itself (depending on the value of update flag)
      // In either case, we just want the sibling path to this leaf - it's up to the avm to distinguish if it's a low leaf or not
      //const siblingPath = await this.merkleTrees.getSiblingPath(MerkleTreeId.PUBLIC_DATA_TREE, leafIndex);
      const leafPreimage = preimage as PublicDataTreeLeafPreimage;

      this.log.trace(`leafPreimage.slot: ${leafPreimage.slot}, leafPreimage.value: ${leafPreimage.value}`);
      this.log.trace(
        `leafPreimage.nextSlot: ${leafPreimage.nextSlot}, leafPreimage.nextIndex: ${Number(leafPreimage.nextIndex)}`,
      );

      if (alreadyPresent) {
        assert(
          leafPreimage.value.equals(value),
          `Value mismatch when performing public data read (got value: ${value}, value in ephemeral tree: ${leafPreimage.value})`,
        );
      } else {
        this.log.trace(`Slot has never been written before!`);
        // Sanity check that the leaf slot is skipped by low leaf when it doesn't exist
        assert(
          leafPreimage.slot.toBigInt() < leafSlot.toBigInt() &&
            (leafPreimage.nextIndex === 0n || leafPreimage.nextSlot.toBigInt() > leafSlot.toBigInt()),
          'Public data tree low leaf should skip the target leaf slot when the target leaf does not exist or is the max value.',
        );
      }
      // On non-existence, AVM circuit will need to recognize that leafPreimage.slot != leafSlot,
      // prove that this is a low leaf that skips leafSlot, and then prove membership of the leaf.
      this.trace.tracePublicStorageRead(
        contractAddress,
        slot,
        value,
        leafPreimage,
        new Fr(leafIndex),
        siblingPath.toFields(),
      );
    } else {
      this.trace.tracePublicStorageRead(contractAddress, slot, value);
    }

    return Promise.resolve(value);
  }

  /**
   * Read from public storage, don't trace the read.
   *
   * @param contractAddress - the address of the contract whose storage is being read from
   * @param slot - the slot in the contract's storage being read from
   * @returns the latest value written to slot, or 0 if never written to before
   */
  public async peekStorage(contractAddress: AztecAddress, slot: Fr): Promise<Fr> {
    const { value, cached } = await this.publicStorage.read(contractAddress, slot);
    this.log.trace(`Storage peek  (address=${contractAddress}, slot=${slot}): value=${value},  cached=${cached}`);
    return Promise.resolve(value);
  }

  // TODO(4886): We currently don't silo note hashes.
  /**
   * Check if a note hash exists at the given leaf index, trace the check.
   *
   * @param contractAddress - the address of the contract whose storage is being read from
   * @param noteHash - the unsiloed note hash being checked
   * @param leafIndex - the leaf index being checked
   * @returns true if the note hash exists at the given leaf index, false otherwise
   */
  public async checkNoteHashExists(contractAddress: AztecAddress, noteHash: Fr, leafIndex: Fr): Promise<boolean> {
    const gotLeafValue = (await this.worldStateDB.getCommitmentValue(leafIndex.toBigInt())) ?? Fr.ZERO;
    const exists = gotLeafValue.equals(noteHash);
    this.log.trace(
      `noteHashes(${contractAddress})@${noteHash} ?? leafIndex: ${leafIndex} | gotLeafValue: ${gotLeafValue}, exists: ${exists}.`,
    );
    if (this.doMerkleOperations) {
      // TODO(8287): We still return exists here, but we need to transmit both the requested noteHash and the gotLeafValue
      // such that the VM can constrain the equality and decide on exists based on that.
      //const path = await this.merkleTrees.getSiblingPath(MerkleTreeId.NOTE_HASH_TREE, leafIndex.toBigInt());
      const path = await this.db.getSiblingPath(MerkleTreeId.NOTE_HASH_TREE, leafIndex.toBigInt());
      this.trace.traceNoteHashCheck(contractAddress, gotLeafValue, leafIndex, exists, path.toFields());
    } else {
      this.trace.traceNoteHashCheck(contractAddress, gotLeafValue, leafIndex, exists);
    }
    return Promise.resolve(exists);
  }

  /**
   * Write a raw note hash, silo it and make it unique, then trace the write.
   * @param noteHash - the unsiloed note hash to write
   */
  public async writeNoteHash(contractAddress: AztecAddress, noteHash: Fr): Promise<void> {
    this.log.debug(`noteHashes(${contractAddress}) += ${noteHash}.`);
    const siloedNoteHash = await siloNoteHash(contractAddress, noteHash);
    this.log.debug(`siloedNoteHash=${siloedNoteHash}.`);

    await this.writeSiloedNoteHash(siloedNoteHash);
  }

  /**
   * Write a note hash, make it unique, trace the write.
   * @param noteHash - the non unique note hash to write
   */
  public async writeSiloedNoteHash(noteHash: Fr): Promise<void> {
    this.log.debug(`note hash count: ${this.trace.getNoteHashCount()}`);
    this.log.debug(`firstNullifier: ${this.firstNullifier}`);
    const nonce = await computeNoteHashNonce(this.firstNullifier, this.trace.getNoteHashCount());
    this.log.debug(`nonce: ${nonce}`);
    const uniqueNoteHash = await computeUniqueNoteHash(nonce, noteHash);
    this.log.debug(`uniqueNoteHash: ${uniqueNoteHash}`);

    await this.writeUniqueNoteHash(uniqueNoteHash);
  }

  /**
   * Write a note hash, trace the write.
   * @param uniqueNoteHash - the siloed unique hash to write
   */
  public async writeUniqueNoteHash(uniqueNoteHash: Fr): Promise<void> {
    this.log.trace(`noteHashes += @${uniqueNoteHash}.`);

    if (this.doMerkleOperations) {
      // Should write a helper for this
      //const leafIndex = new Fr(this.merkleTrees.treeMap.get(MerkleTreeId.NOTE_HASH_TREE)!.leafCount);
      const treeInfo = await this.db.getTreeInfo(MerkleTreeId.NOTE_HASH_TREE);
      const leafIndex = new Fr(treeInfo.size);
      //const insertionPath = await this.merkleTrees.appendNoteHash(noteHash);
      await this.db.appendLeaves(MerkleTreeId.NOTE_HASH_TREE, [uniqueNoteHash]);
      const insertionPath = await this.db.getSiblingPath(MerkleTreeId.NOTE_HASH_TREE, leafIndex.toBigInt());
      this.trace.traceNewNoteHash(uniqueNoteHash, leafIndex, insertionPath.toFields());
    } else {
      this.trace.traceNewNoteHash(uniqueNoteHash);
    }
  }

  /**
   * Check if a nullifier exists, trace the check.
   * @param contractAddress - address of the contract that the nullifier is associated with
   * @param nullifier - the unsiloed nullifier to check
   * @returns exists - whether the nullifier exists in the nullifier set
   */
  public async checkNullifierExists(contractAddress: AztecAddress, nullifier: Fr): Promise<boolean> {
    this.log.trace(`Checking existence of nullifier (address=${contractAddress}, nullifier=${nullifier})`);
    const siloedNullifier = await siloNullifier(contractAddress, nullifier);
    const [exists, leafOrLowLeafPreimage, leafOrLowLeafIndex, leafOrLowLeafPath] = await this.getNullifierMembership(
      siloedNullifier,
    );

    if (this.doMerkleOperations) {
      this.trace.traceNullifierCheck(
        siloedNullifier,
        exists,
        leafOrLowLeafPreimage,
        leafOrLowLeafIndex,
        leafOrLowLeafPath,
      );
    } else {
      this.trace.traceNullifierCheck(siloedNullifier, exists);
    }
    return Promise.resolve(exists);
  }

  /**
   * Helper to get membership information for a siloed nullifier when checking its existence.
   * Optionally trace the nullifier check.
   *
   * @param siloedNullifier - the siloed nullifier to get membership information for
   * @returns
   *     - exists - whether the nullifier exists in the nullifier set
   *     - leafOrLowLeafPreimage - the preimage of the nullifier leaf or its low-leaf if it doesn't exist
   *     - leafOrLowLeafIndex - the leaf index of the nullifier leaf or its low-leaf if it doesn't exist
   *     - leafOrLowLeafPath - the sibling path of the nullifier leaf or its low-leaf if it doesn't exist
   */
  private async getNullifierMembership(
    siloedNullifier: Fr,
  ): Promise<
    [
      /*exists=*/ boolean,
      /*leafOrLowLeafPreimage=*/ NullifierLeafPreimage,
      /*leafOrLowLeafIndex=*/ Fr,
      /*leafOrLowLeafIndexPath=*/ Fr[],
    ]
  > {
    const [exists, isPending, _] = await this.nullifiers.checkExists(siloedNullifier);
    this.log.trace(`Checked siloed nullifier ${siloedNullifier} (exists=${exists}), pending=${isPending}`);

    if (this.doMerkleOperations) {
      // Get leaf if present, low leaf if absent
      // If leaf is present, hint/trace it. Otherwise, hint/trace the low leaf.
      const { preimage, leafIndex, alreadyPresent } = await this.getLeafOrLowLeafInfo(
        MerkleTreeId.NULLIFIER_TREE,
        siloedNullifier.toBigInt(),
      );
      //} = await this.merkleTrees.getLeafOrLowLeafInfo(MerkleTreeId.NULLIFIER_TREE, siloedNullifier);
      const leafPreimage = preimage as NullifierLeafPreimage;
      //const leafPath = await this.merkleTrees.getSiblingPath(MerkleTreeId.NULLIFIER_TREE, leafIndex);
      const leafPath = await this.db.getSiblingPath(MerkleTreeId.NULLIFIER_TREE, leafIndex);

      assert(
        alreadyPresent == exists,
        'WorldStateDB contains nullifier leaf, but merkle tree does not (or vice versa).... This is a bug!',
      );

      if (exists) {
        this.log.trace(`Siloed nullifier ${siloedNullifier} exists at leafIndex=${leafIndex}`);
      } else {
        // Sanity check that the leaf value is skipped by low leaf when it doesn't exist
        assert(
          leafPreimage.nullifier.toBigInt() < siloedNullifier.toBigInt() &&
            (leafPreimage.nextIndex === 0n || leafPreimage.nextNullifier.toBigInt() > siloedNullifier.toBigInt()),
          'Nullifier tree low leaf should skip the target leaf nullifier when the target leaf does not exist.',
        );
      }
      return [exists, leafPreimage, new Fr(leafIndex), leafPath.toFields()];
    } else {
      return [exists, NullifierLeafPreimage.empty(), Fr.ZERO, []];
    }
  }

  /**
   * Write a nullifier to the nullifier set, trace the write.
   * @param contractAddress - address of the contract that the nullifier is associated with
   * @param nullifier - the unsiloed nullifier to write
   */
  public async writeNullifier(contractAddress: AztecAddress, nullifier: Fr) {
    this.log.trace(`Inserting new nullifier (address=${nullifier}, nullifier=${contractAddress})`);
    const siloedNullifier = await siloNullifier(contractAddress, nullifier);
    await this.writeSiloedNullifier(siloedNullifier);
  }

  /**
   * Write a nullifier to the nullifier set, trace the write.
   * @param siloedNullifier - the siloed nullifier to write
   */
  public async writeSiloedNullifier(siloedNullifier: Fr) {
    this.log.trace(`Inserting siloed nullifier=${siloedNullifier}`);

    if (this.doMerkleOperations) {
      // Maybe overkill, but we should check if the nullifier is already present in the tree before attempting to insert
      // It might be better to catch the error from the insert operation
      // Trace all nullifier creations, even duplicate insertions that fail
      //const { preimage, index, alreadyPresent } = await this.merkleTrees.getLeafOrLowLeafInfo(
      const {
        preimage,
        leafIndex: index,
        alreadyPresent,
      } = await this.getLeafOrLowLeafInfo(MerkleTreeId.NULLIFIER_TREE, siloedNullifier.toBigInt());
      if (alreadyPresent) {
        this.log.verbose(`Siloed nullifier ${siloedNullifier} already present in tree at index ${index}!`);
        // If the nullifier is already present, we should not insert it again
        // instead we provide the direct membership path
        //const path = await this.merkleTrees.getSiblingPath(MerkleTreeId.NULLIFIER_TREE, index);
        const path = await this.db.getSiblingPath(MerkleTreeId.NULLIFIER_TREE, index);
        // This just becomes a nullifier read hint
        this.trace.traceNullifierCheck(
          siloedNullifier,
          /*exists=*/ alreadyPresent,
          preimage as NullifierLeafPreimage,
          new Fr(index),
          path.toFields(),
        );
        throw new NullifierCollisionError(
          `Siloed nullifier ${siloedNullifier} already exists in parent cache or host.`,
        );
      } else {
        // Cache pending nullifiers for later access
        await this.nullifiers.append(siloedNullifier);
        // We append the new nullifier
        this.log.trace(
          `Nullifier tree root before insertion ${new Fr(
            (await this.db.getTreeInfo(MerkleTreeId.NULLIFIER_TREE)).root,
          )}`,
        );
        //this.log.debug(
        //  `Nullifier tree root before insertion ${await this.merkleTrees.treeMap
        //    .get(MerkleTreeId.NULLIFIER_TREE)!
        //    .getRoot()}`,
        //);
        //const appendResult = await this.merkleTrees.appendNullifier(siloedNullifier);
        //const result = await this.db.batchInsert(MerkleTreeId.NULLIFIER_TREE, [siloedNullifier.toBuffer()], NULLIFIER_TREE_HEIGHT);
        const appendResult = await this.db.sequentialInsert(MerkleTreeId.NULLIFIER_TREE, [siloedNullifier.toBuffer()]);
        this.log.trace(
          `Nullifier tree root after insertion ${new Fr(
            (await this.db.getTreeInfo(MerkleTreeId.NULLIFIER_TREE)).root,
          )}`,
        );
        //this.log.debug(
        //  `Nullifier tree root after insertion ${await this.merkleTrees.treeMap
        //    .get(MerkleTreeId.NULLIFIER_TREE)!
        //    .getRoot()}`,
        //);
        //const lowLeafPreimage = appendResult.lowWitness.preimage as NullifierLeafPreimage;
        //const lowLeafIndex = appendResult.lowWitness.index;
        //const lowLeafPath = appendResult.lowWitness.siblingPath;
        //const insertionPath = appendResult.insertionPath;
        const lowLeafWitnessData = appendResult.lowLeavesWitnessData![0];
        const lowLeafPreimage = lowLeafWitnessData.leafPreimage as NullifierLeafPreimage;
        const lowLeafIndex = lowLeafWitnessData.index;
        const lowLeafPath = lowLeafWitnessData.siblingPath.toFields();
        const insertionPath = appendResult.insertionWitnessData[0].siblingPath.toFields();
        //const insertionPath = result.newSubtreeSiblingPath.toFields();
        this.trace.traceNewNullifier(
          siloedNullifier,
          lowLeafPreimage,
          new Fr(lowLeafIndex),
          lowLeafPath,
          insertionPath,
        );
      }
    } else {
      // Cache pending nullifiers for later access
      await this.nullifiers.append(siloedNullifier);
      this.trace.traceNewNullifier(siloedNullifier);
    }
  }

  public async writeSiloedNullifiersFromPrivate(siloedNullifiers: Fr[]) {
    for (const siloedNullifier of siloedNullifiers.filter(n => !n.isEmpty())) {
      await this.writeSiloedNullifier(siloedNullifier);
    }
  }

  /**
   * Check if an L1 to L2 message exists, trace the check.
   * @param msgHash - the message hash to check existence of
   * @param msgLeafIndex - the message leaf index to use in the check
   * @returns exists - whether the message exists in the L1 to L2 Messages tree
   */
  public async checkL1ToL2MessageExists(
    contractAddress: AztecAddress,
    msgHash: Fr,
    msgLeafIndex: Fr,
  ): Promise<boolean> {
    const valueAtIndex = (await this.worldStateDB.getL1ToL2LeafValue(msgLeafIndex.toBigInt())) ?? Fr.ZERO;
    const exists = valueAtIndex.equals(msgHash);
    this.log.trace(
      `l1ToL2Messages(@${msgLeafIndex}) ?? exists: ${exists}, expected: ${msgHash}, found: ${valueAtIndex}.`,
    );

    if (this.doMerkleOperations) {
      // TODO(8287): We still return exists here, but we need to transmit both the requested msgHash and the value
      // such that the VM can constrain the equality and decide on exists based on that.
      // We should defintely add a helper here
      //const path = await this.merkleTrees.treeDb.getSiblingPath(
      const path = await this.db.getSiblingPath(MerkleTreeId.L1_TO_L2_MESSAGE_TREE, msgLeafIndex.toBigInt());
      this.trace.traceL1ToL2MessageCheck(contractAddress, valueAtIndex, msgLeafIndex, exists, path.toFields());
    } else {
      this.trace.traceL1ToL2MessageCheck(contractAddress, valueAtIndex, msgLeafIndex, exists);
    }
    return Promise.resolve(exists);
  }

  /**
   * Write an L2 to L1 message.
   * @param contractAddress - L2 contract address that created this message
   * @param recipient - L1 contract address to send the message to.
   * @param content - Message content.
   */
  public writeL2ToL1Message(contractAddress: AztecAddress, recipient: Fr, content: Fr) {
    this.log.trace(`L2ToL1Messages(${contractAddress}) += (recipient: ${recipient}, content: ${content}).`);
    this.trace.traceNewL2ToL1Message(contractAddress, recipient, content);
  }

  /**
   * Write a public log
   * @param contractAddress - address of the contract that emitted the log
   * @param log - log contents
   */
  public writePublicLog(contractAddress: AztecAddress, log: Fr[]) {
    this.log.trace(`PublicLog(${contractAddress}) += event with ${log.length} fields.`);
    this.trace.tracePublicLog(contractAddress, log);
  }

  /**
   * Get a contract instance.
   * @param contractAddress - address of the contract instance to retrieve.
   * @returns the contract instance or undefined if it does not exist.
   */
  public async getContractInstance(contractAddress: AztecAddress): Promise<SerializableContractInstance | undefined> {
    this.log.trace(`Getting contract instance for address ${contractAddress}`);
    const instanceWithAddress = await this.worldStateDB.getContractInstance(contractAddress);
    const exists = instanceWithAddress !== undefined;

    let [existsInTree, leafOrLowLeafPreimage, leafOrLowLeafIndex, leafOrLowLeafPath] = [
      exists,
      NullifierLeafPreimage.empty(),
      Fr.ZERO,
      new Array<Fr>(),
    ];
    if (!contractAddressIsCanonical(contractAddress)) {
      const contractAddressNullifier = await siloNullifier(
        AztecAddress.fromNumber(DEPLOYER_CONTRACT_ADDRESS),
        contractAddress.toField(),
      );
      [existsInTree, leafOrLowLeafPreimage, leafOrLowLeafIndex, leafOrLowLeafPath] = await this.getNullifierMembership(
        /*siloedNullifier=*/ contractAddressNullifier,
      );
      assert(
        exists == existsInTree,
        'WorldStateDB contains contract instance, but nullifier tree does not contain contract address (or vice versa).... This is a bug!',
      );
    }

    if (exists) {
      const instance = new SerializableContractInstance(instanceWithAddress);
      this.log.trace(
        `Got contract instance (address=${contractAddress}): exists=${exists}, instance=${jsonStringify(instance)}`,
      );
      if (this.doMerkleOperations) {
        this.trace.traceGetContractInstance(
          contractAddress,
          exists,
          instance,
          leafOrLowLeafPreimage,
          leafOrLowLeafIndex,
          leafOrLowLeafPath,
        );
      } else {
        this.trace.traceGetContractInstance(contractAddress, exists, instance);
      }

      return Promise.resolve(instance);
    } else {
      this.log.debug(`Contract instance NOT FOUND (address=${contractAddress})`);
      if (this.doMerkleOperations) {
        this.trace.traceGetContractInstance(
          contractAddress,
          exists,
          /*instance=*/ undefined,
          leafOrLowLeafPreimage,
          leafOrLowLeafIndex,
          leafOrLowLeafPath,
        );
      } else {
        this.trace.traceGetContractInstance(contractAddress, exists);
      }
      return Promise.resolve(undefined);
    }
  }

  /**
   * Get a contract's bytecode from the contracts DB, also trace the contract class and instance
   */
  public async getBytecode(contractAddress: AztecAddress): Promise<Buffer | undefined> {
    this.log.debug(`Getting bytecode for contract address ${contractAddress}`);
    const instanceWithAddress = await this.worldStateDB.getContractInstance(contractAddress);
    const exists = instanceWithAddress !== undefined;

    let [existsInTree, leafOrLowLeafPreimage, leafOrLowLeafIndex, leafOrLowLeafPath] = [
      exists,
      NullifierLeafPreimage.empty(),
      Fr.ZERO,
      new Array<Fr>(),
    ];
    if (!contractAddressIsCanonical(contractAddress)) {
      const contractAddressNullifier = await siloNullifier(
        AztecAddress.fromNumber(DEPLOYER_CONTRACT_ADDRESS),
        contractAddress.toField(),
      );
      [existsInTree, leafOrLowLeafPreimage, leafOrLowLeafIndex, leafOrLowLeafPath] = await this.getNullifierMembership(
        /*siloedNullifier=*/ contractAddressNullifier,
      );
      assert(
        exists == existsInTree,
        'WorldStateDB contains contract instance, but nullifier tree does not contain contract address (or vice versa).... This is a bug!',
      );
    }

    if (exists) {
      const instance = new SerializableContractInstance(instanceWithAddress);
      const contractClass = await this.worldStateDB.getContractClass(instance.contractClassId);
      const bytecodeCommitment = await this.worldStateDB.getBytecodeCommitment(instance.contractClassId);

      assert(
        contractClass,
        `Contract class not found in DB, but a contract instance was found with this class ID (${instance.contractClassId}). This should not happen!`,
      );

      assert(
        bytecodeCommitment,
        `Bytecode commitment was not found in DB for contract class (${instance.contractClassId}). This should not happen!`,
      );

      const contractClassPreimage = {
        artifactHash: contractClass.artifactHash,
        privateFunctionsRoot: contractClass.privateFunctionsRoot,
        publicBytecodeCommitment: bytecodeCommitment,
      };

      if (this.doMerkleOperations) {
        this.trace.traceGetBytecode(
          contractAddress,
          exists,
          contractClass.packedBytecode,
          instance,
          contractClassPreimage,
          leafOrLowLeafPreimage,
          leafOrLowLeafIndex,
          leafOrLowLeafPath,
        );
      } else {
        this.trace.traceGetBytecode(
          contractAddress,
          exists,
          contractClass.packedBytecode,
          instance,
          contractClassPreimage,
        );
      }

      return contractClass.packedBytecode;
    } else {
      // If the contract instance is not found, we assume it has not been deployed.
      // It doesnt matter what the values of the contract instance are in this case, as long as we tag it with exists=false.
      // This will hint to the avm circuit to just perform the non-membership check on the address and disregard the bytecode hash
      if (this.doMerkleOperations) {
        this.trace.traceGetBytecode(
          contractAddress,
          exists,
          /*instance=*/ undefined,
          /*contractClass=*/ undefined,
          /*bytecode=*/ undefined,
          leafOrLowLeafPreimage,
          leafOrLowLeafIndex,
          leafOrLowLeafPath,
        );
      } else {
        this.trace.traceGetBytecode(contractAddress, exists); // bytecode, instance, class undefined
      }
      return undefined;
    }
  }

  public traceEnqueuedCall(publicCallRequest: PublicCallRequest, calldata: Fr[], reverted: boolean) {
    this.trace.traceEnqueuedCall(publicCallRequest, calldata, reverted);
  }

  public async getPublicFunctionDebugName(avmEnvironment: AvmExecutionEnvironment): Promise<string> {
    return await getPublicFunctionDebugName(this.worldStateDB, avmEnvironment.address, avmEnvironment.calldata);
  }

  public async getLeafOrLowLeafInfo<ID extends IndexedTreeId, T extends IndexedTreeLeafPreimage>(
    treeId: ID,
    key: bigint,
  ): Promise<GetLeafResult<T>> {
    // "key" is siloed slot (leafSlot) or siloed nullifier
    const leafOrLowLeafIndex = await this.db.getPreviousValueIndex(treeId, key);
    assert(
      leafOrLowLeafIndex !== undefined,
      `${MerkleTreeId[treeId]} low leaf index should always be found (even if target leaf does not exist)`,
    );
    const { index: leafIndex, alreadyPresent } = leafOrLowLeafIndex;

    const leafPreimage = await this.db.getLeafPreimage(treeId, leafIndex);
    assert(
      leafPreimage !== undefined,
      `${MerkleTreeId[treeId]}  low leaf preimage should never be undefined (even if target leaf does not exist)`,
    );

    return { preimage: leafPreimage as T, leafIndex, alreadyPresent };
  }
}

function contractAddressIsCanonical(contractAddress: AztecAddress): boolean {
  return (
    contractAddress.equals(AztecAddress.fromNumber(CANONICAL_AUTH_REGISTRY_ADDRESS)) ||
    contractAddress.equals(AztecAddress.fromNumber(DEPLOYER_CONTRACT_ADDRESS)) ||
    contractAddress.equals(AztecAddress.fromNumber(REGISTERER_CONTRACT_ADDRESS)) ||
    contractAddress.equals(AztecAddress.fromNumber(MULTI_CALL_ENTRYPOINT_ADDRESS)) ||
    contractAddress.equals(AztecAddress.fromNumber(FEE_JUICE_ADDRESS)) ||
    contractAddress.equals(AztecAddress.fromNumber(ROUTER_ADDRESS))
  );
}
