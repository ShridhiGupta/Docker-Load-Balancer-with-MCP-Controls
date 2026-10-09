/**
 * Interactive & Direct CLI for Controlling Botpresso Traffic Splitter
 * Usage:
 *   npx tsx scripts/split-cli.ts [splitA] [splitB]
 *   npm run split -- 80 20
 *   npm run split
 */

import readline from 'readline';

const CONTROLLER_URL = process.env.CONTROLLER_URL || 'http://localhost:8000';

async function getStatus() {
  try {
    const res = await fetch(`${CONTROLLER_URL}/api/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err: any) {
    console.error(`\x1b[31m[ERROR]\x1b[0m Cannot connect to Controller at ${CONTROLLER_URL}: ${err.message}`);
    process.exit(1);
  }
}

async function startContainer(containerId: 'A' | 'B') {
  console.log(`\x1b[33m[INFO]\x1b[0m Starting Container ${containerId}...`);
  const res = await fetch(`${CONTROLLER_URL}/api/containers/${containerId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-source': 'cli' },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Failed to start Container ${containerId}`);
  }
  console.log(`\x1b[32m[OK]\x1b[0m Container ${containerId} is now healthy!`);
}

async function applySplit(splitA: number, splitB: number) {
  const status = await getStatus();

  // Auto-start stopped container if routing traffic to it
  if (splitA > 0 && status.containers.A.status === 'STOPPED') {
    await startContainer('A');
  }
  if (splitB > 0 && status.containers.B.status === 'STOPPED') {
    await startContainer('B');
  }

  const res = await fetch(`${CONTROLLER_URL}/api/split`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-source': 'cli' },
    body: JSON.stringify({ splitA, splitB }),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error(`\n\x1b[31m[REJECTED]\x1b[0m ${data.error}`);
    return false;
  }

  console.log(`\n\x1b[32m[SUCCESS]\x1b[0m Traffic split updated!`);
  console.log(`  Configured: \x1b[36m${splitA}% Container A\x1b[0m | \x1b[35m${splitB}% Container B\x1b[0m`);
  console.log(`  Effective:  \x1b[36m${data.effectiveSplit.effectiveA}% Container A\x1b[0m | \x1b[35m${data.effectiveSplit.effectiveB}% Container B\x1b[0m`);
  console.log(`  Reason:     ${data.effectiveSplit.reason}`);
  return true;
}

async function main() {
  const argA = process.argv[2];
  const argB = process.argv[3];

  if (argA !== undefined) {
    const a = parseInt(argA, 10);
    const b = argB !== undefined ? parseInt(argB, 10) : 100 - a;
    if (isNaN(a) || isNaN(b) || a < 0 || a > 100 || b < 0 || b > 100 || a + b !== 100) {
      console.error('\x1b[31m[ERROR]\x1b[0m Split percentages must be numbers between 0 and 100 that sum to 100.');
      process.exit(1);
    }
    await applySplit(a, b);
    process.exit(0);
  }

  // Interactive Menu
  const status = await getStatus();
  console.log('================================================================');
  console.log('  🔀 Botpresso Traffic Split Controller CLI');
  console.log('================================================================');
  console.log(`  Container A: [${status.containers.A.status}] (Total Served: ${status.containers.A.totalRequestsServed})`);
  console.log(`  Container B: [${status.containers.B.status}] (Total Served: ${status.containers.B.totalRequestsServed})`);
  console.log(`  Current Split: ${status.configuredSplit.splitA}% A / ${status.configuredSplit.splitB}% B`);
  console.log(`  Effective Split: ${status.effectiveSplit.effectiveA}% A / ${status.effectiveSplit.effectiveB}% B`);
  console.log('----------------------------------------------------------------');
  console.log('  Choose a split preset:');
  console.log('    1) 100% Container A /   0% Container B');
  console.log('    2)  80% Container A /  20% Container B');
  console.log('    3)  50% Container A /  50% Container B');
  console.log('    4)  20% Container A /  80% Container B');
  console.log('    5)   0% Container A / 100% Container B');
  console.log('    6) Custom ratio (enter custom % for A and B)');
  console.log('    7) Exit');
  console.log('----------------------------------------------------------------');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('Select choice (1-7): ', async (choice) => {
    switch (choice.trim()) {
      case '1':
        await applySplit(100, 0);
        rl.close();
        break;
      case '2':
        await applySplit(80, 20);
        rl.close();
        break;
      case '3':
        await applySplit(50, 50);
        rl.close();
        break;
      case '4':
        await applySplit(20, 80);
        rl.close();
        break;
      case '5':
        await applySplit(0, 100);
        rl.close();
        break;
      case '6':
        rl.question('Enter % for Container A (0-100): ', async (ansA) => {
          const a = parseInt(ansA.trim(), 10);
          if (isNaN(a) || a < 0 || a > 100) {
            console.error('\x1b[31m[ERROR]\x1b[0m Invalid percentage.');
            rl.close();
            return;
          }
          await applySplit(a, 100 - a);
          rl.close();
        });
        break;
      default:
        console.log('Exiting without changes.');
        rl.close();
        break;
    }
  });
}

main().catch((err) => {
  console.error('[ERROR]', err);
  process.exit(1);
});
