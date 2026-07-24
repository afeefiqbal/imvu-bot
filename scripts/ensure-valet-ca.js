/**
 * Node does not trust Laravel Valet’s local HTTPS CA by default.
 * If the Valet CA exists and NODE_EXTRA_CA_CERTS is unset, re-exec once with it set
 * (NODE_EXTRA_CA_CERTS is only read at process start).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const caPath = path.join(os.homedir(), '.config/valet/CA/LaravelValetCASelfSigned.pem');

if (
    fs.existsSync(caPath) &&
    !process.env.NODE_EXTRA_CA_CERTS &&
    !process.env.IMVU_SKIP_VALET_CA
) {
    const result = spawnSync(process.execPath, process.argv.slice(1), {
        stdio: 'inherit',
        env: {
            ...process.env,
            NODE_EXTRA_CA_CERTS: caPath,
        },
    });
    process.exit(result.status === null ? 1 : result.status);
}
