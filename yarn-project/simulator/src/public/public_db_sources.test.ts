import { type MerkleTreeWriteOperations } from '@aztec/circuit-types';
import { AztecAddress, type ContractDataSource, Fr } from '@aztec/circuits.js';
import { NativeWorldStateService } from '@aztec/world-state';

import { type MockProxy, mock } from 'jest-mock-extended';

import { WorldStateDB } from './public_db_sources.js';

const DB_VALUES_SIZE = 10;

describe('world_state_public_db', () => {
  let db: MerkleTreeWriteOperations;
  const contractDataSource: MockProxy<ContractDataSource> = mock<ContractDataSource>();
  let addresses: AztecAddress[];
  let slots: Fr[];
  let dbValues: Fr[];

  let worldStateDB: WorldStateDB;

  beforeEach(async () => {
    addresses = await Promise.all(Array(DB_VALUES_SIZE).fill(0).map(AztecAddress.random));
    slots = Array(DB_VALUES_SIZE).fill(0).map(Fr.random);
    dbValues = Array(DB_VALUES_SIZE).fill(0).map(Fr.random);
    db = await (await NativeWorldStateService.tmp()).fork();
    worldStateDB = new WorldStateDB(db, contractDataSource);
  });

  it('reads unwritten value', async function () {
    expect(await worldStateDB.storageRead(addresses[0], slots[0])).toEqual(Fr.ZERO);
    expect(await worldStateDB.storageRead(addresses[1], slots[1])).toEqual(Fr.ZERO);
  });

  it('reads written value back', async function () {
    expect(await worldStateDB.storageRead(addresses[0], slots[0])).toEqual(Fr.ZERO);

    const newValue = dbValues[0];

    // write a new value to our first value
    await worldStateDB.storageWrite(addresses[0], slots[0], newValue);

    // should read back the uncommitted value
    expect(await worldStateDB.storageRead(addresses[0], slots[0])).toEqual(newValue);

    // other slots should be unchanged
    expect(await worldStateDB.storageRead(addresses[1], slots[1])).toEqual(Fr.ZERO);
  });
});
