import type { DeployAccountOptions, PXE } from '@aztec/aztec.js';
import { prettyPrintJSON } from '@aztec/cli/cli-utils';
import { Fr } from '@aztec/foundation/fields';
import type { LogFn, Logger } from '@aztec/foundation/log';

import { type AccountType, createOrRetrieveAccount } from '../utils/accounts.js';
import { type IFeeOpts, printGasEstimates } from '../utils/options/fees.js';

export async function createAccount(
  client: PXE,
  accountType: AccountType,
  secretKey: Fr | undefined,
  publicKey: string | undefined,
  alias: string | undefined,
  registerOnly: boolean,
  publicDeploy: boolean,
  skipInitialization: boolean,
  wait: boolean,
  feeOpts: IFeeOpts,
  json: boolean,
  debugLogger: Logger,
  log: LogFn,
) {
  secretKey ??= Fr.random();

  const account = await createOrRetrieveAccount(
    client,
    undefined /* address, we don't have it yet */,
    undefined /* db, as we want to create from scratch */,
    secretKey,
    accountType,
    Fr.ZERO,
    publicKey,
  );
  const { salt } = account.getInstance();
  const { address, publicKeys, partialAddress } = await account.getCompleteAddress();

  const out: Record<string, any> = {};
  if (json) {
    out.address = address;
    out.publicKey = publicKeys;
    if (secretKey) {
      out.secretKey = secretKey;
    }
    out.partialAddress = partialAddress;
    out.salt = salt;
    out.initHash = account.getInstance().initializationHash;
    out.deployer = account.getInstance().deployer;
  } else {
    log(`\nNew account:\n`);
    log(`Address:         ${address.toString()}`);
    log(`Public key:      ${publicKeys.toString()}`);
    if (secretKey) {
      log(`Secret key:     ${secretKey.toString()}`);
    }
    log(`Partial address: ${partialAddress.toString()}`);
    log(`Salt:            ${salt.toString()}`);
    log(`Init hash:       ${account.getInstance().initializationHash.toString()}`);
    log(`Deployer:        ${account.getInstance().deployer.toString()}`);
  }

  let tx;
  let txReceipt;
  if (registerOnly) {
    await account.register();
  } else {
    const wallet = await account.getWallet();
    const deployOpts: DeployAccountOptions = {
      skipClassRegistration: !publicDeploy,
      skipPublicDeployment: !publicDeploy,
      skipInitialization: skipInitialization,
      ...(await feeOpts.toDeployAccountOpts(wallet)),
    };
    if (feeOpts.estimateOnly) {
      const gas = await account.estimateDeploymentGas(deployOpts);
      if (json) {
        out.fee = {
          gasLimits: {
            da: gas.gasLimits.daGas,
            l2: gas.gasLimits.l2Gas,
          },
          teardownGasLimits: {
            da: gas.teardownGasLimits.daGas,
            l2: gas.teardownGasLimits,
          },
        };
      } else {
        printGasEstimates(feeOpts, gas, log);
      }
    } else {
      tx = account.deploy(deployOpts);
      const txHash = await tx.getTxHash();
      debugLogger.debug(`Account contract tx sent with hash ${txHash}`);
      out.txHash = txHash;
      if (wait) {
        if (!json) {
          log(`\nWaiting for account contract deployment...`);
        }
        txReceipt = await tx.wait();
        out.txReceipt = {
          status: txReceipt.status,
          transactionFee: txReceipt.transactionFee,
        };
      }
    }
  }

  if (json) {
    log(prettyPrintJSON(out));
  } else {
    if (tx) {
      log(`Deploy tx hash:  ${await tx.getTxHash()}`);
    }
    if (txReceipt) {
      log(`Deploy tx fee:   ${txReceipt.transactionFee}`);
    }
  }

  return { alias, address, secretKey, salt };
}
