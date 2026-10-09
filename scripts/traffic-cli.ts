/**
 * Standalone CLI Traffic Generator for Botpresso Load Balancer
 * Usage: npx tsx scripts/traffic-cli.ts [rpm] [target_url]
 * Example: npx tsx scripts/traffic-cli.ts 120 http://localhost:8000/service
 */

const rpmArg = parseInt(process.argv[2] || '120', 10);
const targetUrl = process.argv[3] || 'http://localhost:8000/service';

console.log('================================================================');
console.log('  🚀 Botpresso CLI Traffic Generator');
console.log(`  Target URL: ${targetUrl}`);
console.log(`  Rate:       ${rpmArg} RPM (~${(rpmArg / 60).toFixed(1)} req/s)`);
console.log('  Press Ctrl+C to stop');
console.log('================================================================\n');

let totalSent = 0;
let successCount = 0;
let failedCount = 0;
let countA = 0;
let countB = 0;
let latencies: number[] = [];

const intervalMs = Math.max(10, Math.floor(60000 / rpmArg));

async function sendRequest() {
  totalSent++;
  const start = Date.now();

  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'X-Traffic-Generator': 'CLI',
        'X-Request-Id': `cli_${Date.now()}_${totalSent}`,
      },
    });

    const duration = Date.now() - start;
    latencies.push(duration);
    if (latencies.length > 50) latencies.shift();

    if (res.status >= 200 && res.status < 400) {
      successCount++;
      const routed = res.headers.get('x-routed-to') || res.headers.get('x-handled-by') || '';
      if (routed.includes('A')) countA++;
      else if (routed.includes('B')) countB++;

      const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      process.stdout.write(
        `\r[TRAFFIC] Total: ${totalSent} | Success: \x1b[32m${successCount}\x1b[0m | Fail: \x1b[31m${failedCount}\x1b[0m | A: \x1b[36m${countA}\x1b[0m | B: \x1b[35m${countB}\x1b[0m | Avg Latency: ${avg}ms   `
      );
    } else {
      failedCount++;
      process.stdout.write(
        `\r[TRAFFIC] Total: ${totalSent} | Success: \x1b[32m${successCount}\x1b[0m | Fail: \x1b[31m${failedCount} (HTTP ${res.status})\x1b[0m | A: ${countA} | B: ${countB}   `
      );
    }
  } catch (err: any) {
    failedCount++;
    process.stdout.write(
      `\r[TRAFFIC] Total: ${totalSent} | Fail: \x1b[31m${failedCount} (${err.message})\x1b[0m | A: ${countA} | B: ${countB}   `
    );
  }
}

const timer = setInterval(sendRequest, intervalMs);

process.on('SIGINT', () => {
  clearInterval(timer);
  console.log('\n\n================================================================');
  console.log('  Traffic Generator Summary:');
  console.log(`  - Total Sent:     ${totalSent}`);
  console.log(`  - Successful:     ${successCount} (${totalSent > 0 ? ((successCount / totalSent) * 100).toFixed(1) : 0}%)`);
  console.log(`  - Failed:         ${failedCount}`);
  console.log(`  - Served by A:    ${countA}`);
  console.log(`  - Served by B:    ${countB}`);
  console.log('================================================================');
  process.exit(0);
});
