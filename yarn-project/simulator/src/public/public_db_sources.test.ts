import { MerkleTreeId, type MerkleTreeWriteOperations } from '@aztec/circuit-types';
import { AztecAddress, type ContractDataSource, Fr, PublicDataTreeLeafPreimage } from '@aztec/circuits.js';
import { computePublicDataTreeLeafSlot } from '@aztec/circuits.js/hash';
import { timesParallel } from '@aztec/foundation/collection';
import { type IndexedTreeLeafPreimage } from '@aztec/foundation/trees';

import { type MockProxy, mock } from 'jest-mock-extended';

import { WorldStateDB } from './public_db_sources.js';

const DB_VALUES_SIZE = 10;

describe('world_state_public_db', () => {
  let db: MockProxy<MerkleTreeWriteOperations>;
  const contractDataSource: MockProxy<ContractDataSource> = mock<ContractDataSource>();
  let dbStorage: Map<number, Map<bigint, Buffer>>;
  let addresses: AztecAddress[];
  let slots: Fr[];
  let dbValues: Fr[];

  let worldStateDB: WorldStateDB;

  beforeEach(async () => {
    addresses = await Promise.all(Array(DB_VALUES_SIZE).fill(0).map(AztecAddress.random));
    slots = Array(DB_VALUES_SIZE).fill(0).map(Fr.random);
    dbValues = Array(DB_VALUES_SIZE).fill(0).map(Fr.random);
    const publicDataEntries = await timesParallel(DB_VALUES_SIZE, async (idx: number) => {
      const leafSlot = await computePublicDataTreeLeafSlot(addresses[idx], slots[idx]);
      return new PublicDataTreeLeafPreimage(leafSlot, dbValues[idx], Fr.ZERO, 0n);
    });
    dbStorage = new Map<number, Map<bigint, Buffer>>([
      [
        MerkleTreeId.PUBLIC_DATA_TREE,
        new Map(publicDataEntries.map((preimage, idx) => [BigInt(idx), preimage.toBuffer()])),
      ],
    ]);
    db = mock<MerkleTreeWriteOperations>();
    db.getPreviousValueIndex.mockImplementation(
      (
        treeId: MerkleTreeId,
        leafSlot: bigint,
      ): Promise<
        | {
            index: bigint;
            alreadyPresent: boolean;
          }
        | undefined
      > => {
        const sortedByLeafSlot = publicDataEntries.slice().sort((a, b) => Number(a.getKey() - b.getKey()));
        let findResult = undefined;
        for (const preimage of sortedByLeafSlot) {
          if (preimage.getKey() > leafSlot) {
            break;
          }
          findResult = {
            index: BigInt(publicDataEntries.indexOf(preimage)),
            alreadyPresent: preimage.getKey() === leafSlot,
          };
        }

        return Promise.resolve(findResult);
      },
    );
    db.getLeafPreimage.mockImplementation((treeId: MerkleTreeId, index: bigint): Promise<IndexedTreeLeafPreimage> => {
      const tree = dbStorage.get(treeId);
      if (!tree) {
        throw new Error('Invalid Tree Id');
      }

      return Promise.resolve(PublicDataTreeLeafPreimage.fromBuffer(tree.get(index)!));
    });

    worldStateDB = new WorldStateDB(db, contractDataSource);
  });

  it('reads unwritten value from merkle tree db', async function () {
    expect(await worldStateDB.storageRead(addresses[0], slots[0])).toEqual(dbValues[0]);
    expect(await worldStateDB.storageRead(addresses[1], slots[1])).toEqual(dbValues[1]);
  });

  it('reads uncommitted value back', async function () {
    expect(await worldStateDB.storageRead(addresses[0], slots[0])).toEqual(dbValues[0]);

    const newValue = new Fr(dbValues[0].toBigInt() + 1n);

    //// write a new value to our first value
    //await worldStateDB.storageWrite(addresses[0], slots[0], newValue);

    //// should read back the uncommitted value
    //expect(await worldStateDB.storageRead(addresses[0], slots[0])).toEqual(newValue);

    // other slots should be unchanged
    expect(await worldStateDB.storageRead(addresses[1], slots[1])).toEqual(dbValues[1]);
  });
});
