import type { Fr } from '@aztec/foundation/fields';
import { IndexedTaggingSecret } from '@aztec/stdlib/logs';

// Half the size of the window we slide over the tagging secret indexes.
export const WINDOW_HALF_SIZE = 10;

export function getIndexedTaggingSecretsForTheWindow(
  secretsAndWindows: { appTaggingSecret: Fr; leftMostIndex: number; rightMostIndex: number }[],
): IndexedTaggingSecret[] {
  const secrets: IndexedTaggingSecret[] = [];
  for (const secretAndWindow of secretsAndWindows) {
    for (let i = secretAndWindow.leftMostIndex; i <= secretAndWindow.rightMostIndex; i++) {
      secrets.push(new IndexedTaggingSecret(secretAndWindow.appTaggingSecret, i));
    }
  }
  return secrets;
}

/**
 * Creates a map from app tagging secret to initial index.
 * @param indexedTaggingSecrets - The indexed tagging secrets to get the initial indexes from.
 * @returns The map from app tagging secret to initial index.
 */
export function getInitialIndexesMap(indexedTaggingSecrets: IndexedTaggingSecret[]): { [k: string]: number } {
  const initialIndexes: { [k: string]: number } = {};

  for (const indexedTaggingSecret of indexedTaggingSecrets) {
    initialIndexes[indexedTaggingSecret.appTaggingSecret.toString()] = indexedTaggingSecret.index;
  }

  return initialIndexes;
}
