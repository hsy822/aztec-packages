import {
  type IndexedTreeId,
  type MerkleTreeId,
  type MerkleTreeLeafType,
  type MerkleTreeWriteOperations,
  type SiblingPath,
  type TreeInfo,
} from '@aztec/circuit-types';
import { type IndexedTreeLeafPreimage } from '@aztec/foundation/trees';

import { type PublicSideEffectTraceInterface } from '../../public/side_effect_trace_interface.js';

export class DbWrapper {
  constructor(
    private readonly db: MerkleTreeWriteOperations,
    private readonly _trace: PublicSideEffectTraceInterface,
  ) {}

  /**
   * Checkpoints the current fork state
   */
  public async createCheckpoint() {
    await this.db.createCheckpoint();
  }

  /**
   * Commits the current checkpoint
   */
  public async commitCheckpoint() {
    await this.db.commitCheckpoint();
  }

  /**
   * Reverts the current checkpoint
   */
  public async revertCheckpoint() {
    await this.db.revertCheckpoint();
  }

  /**
   * Returns information about the given tree.
   * @param treeId - The tree to be queried.
   */
  async getTreeInfo(treeId: MerkleTreeId): Promise<TreeInfo> {
    const treeInfo = await this.db.getTreeInfo(treeId);
    // trace(treeId, treeInfo);
    return treeInfo;
  }

  /**
   * Appends leaves to a given tree.
   * @param treeId - The tree to be updated.
   * @param leaves - The set of leaves to be appended.
   */
  async appendLeaves<ID extends MerkleTreeId>(treeId: ID, leaves: MerkleTreeLeafType<ID>[]): Promise<void> {
    await this.db.appendLeaves(treeId, leaves);
    // NOTE: Actually, nothing to trace?
    // trace(treeId, leaves, result);
  }

  /**
   * Gets sibling path for a leaf.
   * @param treeId - The tree to be queried for a sibling path.
   * @param index - The index of the leaf for which a sibling path should be returned.
   */
  async getSiblingPath<N extends number>(treeId: MerkleTreeId, index: bigint): Promise<SiblingPath<N>> {
    const insertionPath = await this.db.getSiblingPath(treeId, index);
    // trace(treeId, index, insertionPath);
    return insertionPath as any;
  }

  /**
   * Gets the value for a leaf in the tree.
   * @param treeId - The tree for which the index should be returned.
   * @param index - The index of the leaf.
   */
  getLeafValue<ID extends MerkleTreeId>(
    treeId: ID,
    index: bigint,
  ): Promise<MerkleTreeLeafType<typeof treeId> | undefined> {
    const leafValue = this.db.getLeafValue(treeId, index);
    // trace(treeId, index, leafValue);
    return leafValue;
  }

  /**
   * Returns the index containing a leaf value.
   * @param treeId - The tree for which the index should be returned.
   * @param value - The value to search for in the tree.
   */
  findLeafIndices<ID extends MerkleTreeId>(
    treeId: ID,
    values: MerkleTreeLeafType<ID>[],
  ): Promise<(bigint | undefined)[]> {
    const leafIndices = this.db.findLeafIndices(treeId, values);
    // trace(treeId, values, leafIndices);
    return leafIndices;
  }

  /**
   * Returns the previous index for a given value in an indexed tree.
   * @param treeId - The tree for which the previous value index is required.
   * @param value - The value to be queried.
   */
  getPreviousValueIndex<ID extends IndexedTreeId>(
    treeId: ID,
    value: bigint,
  ): Promise<
    | {
        /**
         * The index of the found leaf.
         */
        index: bigint;
        /**
         * A flag indicating if the corresponding leaf's value is equal to `newValue`.
         */
        alreadyPresent: boolean;
      }
    | undefined
  > {
    const previousIndex = this.db.getPreviousValueIndex(treeId, value);
    // trace(treeId, value, previousIndex);
    return previousIndex;
  }

  /**
   * Returns the data at a specific leaf.
   * @param treeId - The tree for which leaf data should be returned.
   * @param index - The index of the leaf required.
   */
  getLeafPreimage<ID extends IndexedTreeId>(treeId: ID, index: bigint): Promise<IndexedTreeLeafPreimage | undefined> {
    const leafPreimage = this.db.getLeafPreimage(treeId, index);
    // trace(treeId, index, leafPreimage);
    return leafPreimage;
  }
}
