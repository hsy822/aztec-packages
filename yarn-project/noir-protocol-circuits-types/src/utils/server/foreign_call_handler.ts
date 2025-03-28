import { Blob, BlockBlobPublicInputs, SpongeBlob } from '@aztec/blob-lib';
import { Fr } from '@aztec/foundation/fields';
import { applyStringFormatting, createLogger } from '@aztec/foundation/log';
import type { ForeignCallInput, ForeignCallOutput } from '@aztec/noir-acvm_js';

import { strict as assert } from 'assert';

export async function foreignCallHandler(name: string, args: ForeignCallInput[]): Promise<ForeignCallOutput[]> {
  // ForeignCallInput is actually a string[], so the args are string[][].
  const log = createLogger('noir-protocol-circuits:oracle');

  if (name === 'debugLog') {
    assert(args.length === 3, 'expected 3 arguments for debugLog: msg, fields_length, fields');
    const [msgRaw, _ignoredFieldsSize, fields] = args;
    const msg: string = msgRaw.map(acvmField => String.fromCharCode(Fr.fromString(acvmField).toNumber())).join('');
    const fieldsFr: Fr[] = fields.map((field: string) => Fr.fromString(field));
    log.verbose('debug_log ' + applyStringFormatting(msg, fieldsFr));
  } else if (name === 'evaluateBlobs') {
    // TODO(#10323): this was added to save simulation time (~1min in ACVM, ~3mins in wasm -> 500ms).
    // The use of bignum adds a lot of unconstrained code which overloads limits when simulating.
    // If/when simulation times of unconstrained are improved, remove this.
    // Create and evaluate our blobs:
    const paddedBlobsAsFr: Fr[] = args[0].map((field: string) => Fr.fromString(field));
    const kzgCommitments = args[1].map((field: string) => Fr.fromString(field));
    const spongeBlob = SpongeBlob.fromFields(
      args
        .slice(2)
        .flat()
        .map((field: string) => Fr.fromString(field)),
    );
    const blobsAsFr = paddedBlobsAsFr.slice(0, spongeBlob.expectedFields);
    // NB: the above used to be:
    // const blobsAsFr: Fr[] = args[0].map((field: string) => Fr.fromString(field)).filter(field => !field.isZero());
    // ...but we now have private logs which have a fixed number of fields and may have 0 values.
    // TODO(Miranda): trim 0 fields from private logs
    const blobs = await Blob.getBlobs(blobsAsFr);
    const blobPublicInputs = BlockBlobPublicInputs.fromBlobs(blobs);
    // Checks on injected values:
    const hash = await spongeBlob.squeeze();
    blobs.forEach((blob, i) => {
      const injected = kzgCommitments.slice(2 * i, 2 * i + 2);
      const calculated = blob.commitmentToFields();
      if (!calculated[0].equals(injected[0]) || !calculated[1].equals(injected[1])) {
        throw new Error(`Blob commitment mismatch. Real: ${calculated}, Injected: ${injected}`);
      }
      if (!hash.equals(blob.fieldsHash)) {
        throw new Error(
          `Injected blob fields do not match rolled up fields. Real hash: ${hash}, Injected hash: ${blob.fieldsHash}`,
        );
      }
    });
    return Promise.resolve([blobPublicInputs.toFields().map(field => field.toString())]);
  } else if (name === 'noOp') {
    // Workaround for compiler issues where data is deleted because it's "unused"
  } else {
    throw Error(`unexpected oracle during execution: ${name}`);
  }

  return Promise.resolve([]);
}
