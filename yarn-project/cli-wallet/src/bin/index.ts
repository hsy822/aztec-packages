import { Fr, computeSecretHash, fileURLToPath } from '@aztec/aztec.js';
import { LOCALHOST } from '@aztec/cli/cli-utils';
import { type LogFn, createConsoleLogger, createLogger } from '@aztec/foundation/log';
import { openStoreAt } from '@aztec/kv-store/lmdb-v2';
import type { PXEServiceConfig } from '@aztec/pxe/config';

import { Argument, Command, Option } from 'commander';
import { mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';

import { injectCommands } from '../cmds/index.js';
import { Aliases, WalletDB } from '../storage/wallet_db.js';
import { createAliasOption } from '../utils/options/index.js';
import { PXEWrapper } from '../utils/pxe_wrapper.js';

const userLog = createConsoleLogger();
const debugLogger = createLogger('wallet');

const { WALLET_DATA_DIRECTORY = join(homedir(), '.aztec/wallet'), PXE_PROVER = 'none' } = process.env;

function injectInternalCommands(program: Command, log: LogFn, db: WalletDB) {
  program
    .command('alias')
    .description('Aliases information for easy reference.')
    .addArgument(new Argument('<type>', 'Type of alias to create').choices(Aliases))
    .argument('<key>', 'Key to alias.')
    .argument('<value>', 'Value to assign to the alias.')
    .action(async (type, key, value) => {
      value = db.tryRetrieveAlias(value) || value;
      await db.storeAlias(type, key, value, log);
    });

  program
    .command('get-alias')
    .description('Shows stored aliases')
    .addArgument(new Argument('[alias]', 'Alias to retrieve'))
    .action(async alias => {
      if (alias?.includes(':')) {
        const value = await db.retrieveAlias(alias);
        log(value);
      } else {
        const aliases = await db.listAliases(alias);
        for (const { key, value } of aliases) {
          log(`${key} -> ${value}`);
        }
      }
    });

  program
    .command('create-secret')
    .description('Creates an aliased secret to use in other commands')
    .addOption(createAliasOption('Key to alias the secret with', false).makeOptionMandatory(true))
    .action(async (_options, command) => {
      const options = command.optsWithGlobals();
      const { alias } = options;
      const value = Fr.random();
      const hash = computeSecretHash(value);

      await db.storeAlias('secrets', alias, Buffer.from(value.toString()), log);
      await db.storeAlias('secrets', `${alias}:hash`, Buffer.from(hash.toString()), log);
    });

  return program;
}

/** CLI wallet main entrypoint */
async function main() {
  const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
  const walletVersion: string = JSON.parse(readFileSync(packageJsonPath).toString()).version;

  const db = WalletDB.getInstance();
  const pxeWrapper = new PXEWrapper();

  const program = new Command('wallet');
  program
    .description('Aztec wallet')
    .version(walletVersion)
    .option('-d, --data-dir <string>', 'Storage directory for wallet data', WALLET_DATA_DIRECTORY)
    .option('-p, --prover <string>', 'wasm|native|none', PXE_PROVER)
    .addOption(
      new Option('--remote-pxe', 'Connect to an external PXE RPC server, instead of the local one')
        .env('REMOTE_PXE')
        .default(false)
        .conflicts('rpc-url'),
    )
    .addOption(
      new Option('-n, --node-url <string>', 'URL of the Aztec node to connect to')
        .env('AZTEC_NODE_URL')
        .default(`http://${LOCALHOST}:8080`),
    )
    .hook('preSubcommand', async command => {
      const { dataDir, remotePxe, nodeUrl, prover } = command.optsWithGlobals();

      if (!remotePxe) {
        debugLogger.info('Using local PXE service');

        const proverEnabled = prover !== 'none';

        const bbBinaryPath =
          prover === 'native'
            ? resolve(dirname(fileURLToPath(import.meta.url)), '../../../../barretenberg/cpp/build/bin/bb')
            : undefined;
        const bbWorkingDirectory = dataDir + '/bb';
        mkdirSync(bbWorkingDirectory, { recursive: true });

        const overridePXEConfig: Partial<PXEServiceConfig> = {
          proverEnabled,
          bbBinaryPath: prover === 'native' ? bbBinaryPath : undefined,
          bbWorkingDirectory: prover === 'native' ? bbWorkingDirectory : undefined,
        };

        await pxeWrapper.init(nodeUrl, join(dataDir, 'pxe'), overridePXEConfig);
      }
      await db.init(await openStoreAt(dataDir));
    });

  injectCommands(program, userLog, debugLogger, db, pxeWrapper);
  injectInternalCommands(program, userLog, db);
  await program.parseAsync(process.argv);
}

main().catch(err => {
  debugLogger.error(`Error in command execution`);
  debugLogger.error(err + '\n' + err.stack);
  process.exit(1);
});
