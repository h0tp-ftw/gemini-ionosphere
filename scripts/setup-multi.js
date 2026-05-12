import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { spawnSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_PORT = 3001; // First instance starts here (main instance stays on 3000)
const COMPOSE_OUTPUT = 'docker-compose.multi.yml';
const ENV_PREFIX = '.env.instance-';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateApiKey() {
    return `iono_sk_${randomBytes(24).toString('hex')}`;
}

function detectComposeCmd() {
    const dockerStatus = spawnSync('docker', ['--version']);
    const podmanStatus = spawnSync('podman', ['--version']);

    if (!dockerStatus.error) {
        // Check for 'docker compose' (v2 plugin) first
        const composeV2 = spawnSync('docker', ['compose', 'version']);
        if (!composeV2.error && composeV2.status === 0) return 'docker compose';
        return 'docker-compose';
    }
    if (!podmanStatus.error) {
        const hasPodmanCompose = !spawnSync('podman-compose', ['--version']).error;
        return hasPodmanCompose ? 'podman-compose' : 'podman compose';
    }
    return null;
}

/**
 * Run a command interactively (inherits stdio for OAuth flows).
 */
function runInteractive(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            stdio: 'inherit',
            shell: true,
            env: {
                ...process.env,
                NO_BROWSER: 'true',
                GEMINI_CLI_NO_RELAUNCH: 'true',
                GOOGLE_GENAI_USE_GCA: 'true',
                CI: 'true',
                ...options.env
            },
            ...options
        });

        proc.on('close', (code) => {
            if (code === 0 || code === 199) resolve();
            else reject(new Error(`Process exited with code ${code}`));
        });

        proc.on('error', (err) => reject(err));
    });
}

// ─── Core Logic ──────────────────────────────────────────────────────────────

async function collectInstances() {
    const { count } = await inquirer.prompt([{
        type: 'number',
        name: 'count',
        message: 'How many parallel Ionosphere instances do you want?',
        default: 2,
        validate: (v) => v >= 1 && v <= 20 ? true : 'Enter a number between 1 and 20'
    }]);

    const instances = [];

    for (let i = 1; i <= count; i++) {
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`  📡 Configuring Instance ${i} of ${count}`);
        console.log(`${'─'.repeat(50)}`);

        const { name } = await inquirer.prompt([{
            type: 'input',
            name: 'name',
            message: `Instance ${i} — Give it a name (lowercase, no spaces):`,
            default: i === 1 ? 'default' : `instance-${i}`,
            validate: (v) => {
                if (!v.match(/^[a-z0-9][a-z0-9-]*$/)) return 'Use lowercase letters, numbers, and hyphens only.';
                if (instances.some(inst => inst.name === v)) return 'Name already used.';
                return true;
            }
        }]);

        const { authMethod } = await inquirer.prompt([{
            type: 'list',
            name: 'authMethod',
            message: `[${name}] Authentication method:`,
            choices: [
                { name: 'Google OAuth (personal Google account)', value: 'oauth' },
                { name: 'Gemini API Key (AI Studio)', value: 'apikey' }
            ]
        }]);

        let apiKey = '';
        if (authMethod === 'apikey') {
            const { key } = await inquirer.prompt([{
                type: 'input',
                name: 'key',
                message: `[${name}] Enter your Gemini API Key:`,
                validate: (v) => v.length > 0 ? true : 'API Key is required'
            }]);
            apiKey = key;
        }

        const { port } = await inquirer.prompt([{
            type: 'number',
            name: 'port',
            message: `[${name}] Host port bound for this instance:`,
            default: BASE_PORT + (i - 1),
            validate: (v) => {
                if (v < 1024 || v > 65535) return 'Port must be between 1024 and 65535';
                if (instances.some(inst => inst.port === v)) return 'Port already assigned to another instance in this setup';
                return true;
            }
        }]);

        const { maxCli } = await inquirer.prompt([{
            type: 'number',
            name: 'maxCli',
            message: `[${name}] Max concurrent CLI processes for this instance:`,
            default: 5,
            validate: (v) => v >= 1 && v <= 50 ? true : 'Enter a number between 1 and 50'
        }]);

        instances.push({
            name,
            index: i,
            port,
            authMethod,
            apiKey,
            maxCli,
            bridgeKey: generateApiKey(),
        });
    }

    return instances;
}

function generateEnvFile(instance, globalPrefs) {
    const lines = [
        `# Ionosphere Instance: ${instance.name}`,
        `# Generated: ${new Date().toISOString()}`,
        ``,
        `# --- Bridge Auth ---`,
        `API_KEY=${instance.bridgeKey}`,
        `PORT=${instance.port}`,
        `MAX_CONCURRENT_CLI=${instance.maxCli}`,
        ``,
    ];

    // Google Auth block
    lines.push(
        `# --- Google Auth ---`,
        `GEMINI_AUTH_TYPE=${instance.authMethod === 'oauth' ? 'oauth-personal' : 'gemini-api-key'}`,
        ...(instance.authMethod === 'oauth' ? [`GOOGLE_GENAI_USE_GCA=true`] : []),
        ...(instance.apiKey ? [`GEMINI_API_KEY=${instance.apiKey}`] : []),
        ``,
    );

    lines.push(
        ``,
        `# --- CLI Config ---`,
        `GEMINI_CLI_PATH=gemini`,
        `GEMINI_SETTINGS_JSON=/app/settings.json`,
        `GEMINI_HARDENED=true`,
        `GEMINI_DISABLE_TELEMETRY=${globalPrefs.disableTelemetry ? 'true' : 'false'}`,
        `GEMINI_ENABLE_PREVIEW=${globalPrefs.enablePreview ? 'true' : 'false'}`,
        `GEMINI_DISABLE_TOOLS=${globalPrefs.disableTools ? 'true' : 'false'}`,
        `GEMINI_DISABLE_WEB_SEARCH=${globalPrefs.disableWebSearch ? 'true' : 'false'}`,
        `GEMINI_SILENT_FALLBACK=${globalPrefs.silentFallback ? 'true' : 'false'}`,
        `IONOSPHERE_RAW_TOOL_NAMES=true`,
        ``,
        `# --- Runtime ---`,
        `GEMINI_MAX_TURNS=50`,
        `WARM_HANDOFF_ENABLED=true`,
        `CI=true`,
        `NO_BROWSER=true`,
        `GEMINI_CLI_NO_RELAUNCH=true`,
        ``
    );

    return lines.join('\n');
}

function generateComposeFile(instances, useNginx = false) {
    // Build the YAML manually to keep it clean and readable
    const lines = [
        `# Ionosphere Multi-Instance Compose File`,
        `# Generated: ${new Date().toISOString()}`,
        `# Instances: ${instances.map(i => i.name).join(', ')}`,
        `#`,
        `# Usage:`,
        `#   docker compose -f docker-compose.multi.yml up -d --build`,
        `#   (If using podman-compose and containers exist, add: --podman-run-args="--replace")`,
        `#   docker compose -f docker-compose.multi.yml logs -f`,
        `#   docker compose -f docker-compose.multi.yml down`,
        ``,
        `version: "3.8"`,
        ``,
        `services:`,
    ];

    // When nginx is the public face, bind ports to localhost only for security.
    const portBinding = (port) => useNginx ? `127.0.0.1:${port}:${port}` : `${port}:${port}`;

    for (const inst of instances) {
        const serviceName = `ionosphere-${inst.name}`;
        const envFile = `${ENV_PREFIX}${inst.name}`;
        const volumeName = `gemini-config-${inst.name}`;
        const tempDir = `./temp/${inst.name}`;

        lines.push(
            ``,
            `  ${serviceName}:`,
            `    build:`,
            `      context: .`,
            `      args:`,
            `        - GEMINI_DISABLE_TOOLS=\${GEMINI_DISABLE_TOOLS:-false}`,
            `        - GEMINI_DISABLE_WEB_SEARCH=\${GEMINI_DISABLE_WEB_SEARCH:-false}`,
            `    container_name: ${serviceName}`,
            `    restart: unless-stopped`,
            `    tty: true`,
            `    stdin_open: true`,
            `    env_file:`,
            `      - ${envFile}`,
            `    command: node src/index.js`,
            `    ports:`,
            `      - "${portBinding(inst.port)}"`,
            `    volumes:`,
            `      - ${volumeName}:/root/.gemini`,
            `      - ${tempDir}:/app/temp`,
        );
    }

    lines.push(``, `volumes:`);
    for (const inst of instances) {
        lines.push(`  gemini-config-${inst.name}:`);
    }
    lines.push(``);

    return lines.join('\n');
}

// ─── Nginx Config Generator ───────────────────────────────────────────────────

function generateNginxConfig(instances, nginxPrefs) {
    const { hostname, routingMode, selfSigned } = nginxPrefs;

    const certFile = selfSigned
        ? `/etc/ssl/certs/ionosphere-selfsigned.crt`
        : `/etc/letsencrypt/live/${hostname}/fullchain.pem`;
    const keyFile = selfSigned
        ? `/etc/ssl/private/ionosphere-selfsigned.key`
        : `/etc/letsencrypt/live/${hostname}/privkey.pem`;

    const proxyBlock = (port, indent = '        ') => [
        `${indent}proxy_pass http://127.0.0.1:${port};`,
        `${indent}proxy_http_version 1.1;`,
        `${indent}proxy_set_header Host              $host;`,
        `${indent}proxy_set_header X-Real-IP         $remote_addr;`,
        `${indent}proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;`,
        `${indent}proxy_set_header X-Forwarded-Proto $scheme;`,
        `${indent}# SSE / streaming — must disable buffering`,
        `${indent}proxy_buffering           off;`,
        `${indent}proxy_cache               off;`,
        `${indent}chunked_transfer_encoding on;`,
        `${indent}# Allow long Ionosphere turns (3 min)`,
        `${indent}proxy_read_timeout    300s;`,
        `${indent}proxy_send_timeout    300s;`,
        `${indent}proxy_connect_timeout  10s;`,
    ].join('\n');

    const sslLines = (listenPort = 443) => [
        `    listen ${listenPort} ssl;`,
        `    listen [::]:${listenPort} ssl;`,
        `    ssl_certificate     ${certFile};`,
        `    ssl_certificate_key ${keyFile};`,
        `    ssl_protocols TLSv1.2 TLSv1.3;`,
        `    ssl_prefer_server_ciphers on;`,
        `    ssl_ciphers HIGH:!aNULL:!MD5;`,
    ].join('\n');

    const lines = [
        `# Ionosphere — Nginx Reverse Proxy`,
        `# Generated: ${new Date().toISOString()}`,
        `# Host: ${hostname}`,
        `#`,
        `# Install (run as root/sudo):`,
        `#   cp nginx-ionosphere.conf /etc/nginx/sites-available/ionosphere`,
        `#   ln -sf /etc/nginx/sites-available/ionosphere /etc/nginx/sites-enabled/ionosphere`,
        `#   nginx -t && systemctl reload nginx`,
        `#`,
        selfSigned ? [
            `# Self-signed cert was selected. To generate it:`,
            `#   openssl req -x509 -nodes -days 365 -newkey rsa:2048 \\`,
            `#     -keyout /etc/ssl/private/ionosphere-selfsigned.key \\`,
            `#     -out /etc/ssl/certs/ionosphere-selfsigned.crt \\`,
            `#     -subj "/CN=${hostname}"`,
        ].join('\n') : [
            `# Let's Encrypt cert. If not yet issued:`,
            `#   certbot --nginx -d ${hostname} --non-interactive --agree-tos --register-unsafely-without-email`,
            `# Requires ports 80 & 443 open in your cloud firewall/security group.`,
        ].join('\n'),
        ``,
        `# ── HTTP: ACME challenge + redirect ──────────────────────────────────────`,
        `server {`,
        `    listen 80;`,
        `    listen [::]:80;`,
        `    server_name ${hostname};`,
        ``,
        `    location /.well-known/acme-challenge/ {`,
        `        root /var/www/html;`,
        `    }`,
        ``,
        `    location / {`,
        `        return 301 https://$host$request_uri;`,
        `    }`,
        `}`,
    ];

    if (routingMode === 'primary_only') {
        const primary = instances[0];
        lines.push(
            ``,
            `# ── HTTPS: ${primary.name} (primary) on port 443 ────────────────────────────`,
            `server {`,
            sslLines(443),
            `    server_name ${hostname};`,
            ``,
            `    location / {`,
            proxyBlock(primary.port),
            `    }`,
            `}`,
        );
        if (instances.length > 1) {
            lines.push(
                ``,
                `# Note: only the primary instance (${primary.name}) is exposed publicly.`,
                `# Other instances are localhost-only: ${instances.slice(1).map(i => `${i.name}:${i.port}`).join(', ')}`,
            );
        }
    } else {
        // multi-port: 443, 8443, 9443 ...
        const httpsPorts = [443, 8443, 9443, 10443, 11443, 12443, 13443, 14443, 15443, 16443];
        for (let i = 0; i < instances.length; i++) {
            const inst = instances[i];
            const httpsPort = httpsPorts[i] ?? (8000 + i);
            lines.push(
                ``,
                `# ── HTTPS port ${httpsPort}: ${inst.name} ──────────────────────────────────────`,
                `server {`,
                sslLines(httpsPort),
                `    server_name ${hostname};`,
                ``,
                `    location / {`,
                proxyBlock(inst.port),
                `    }`,
                `}`,
            );
        }
    }

    return lines.join('\n');
}

async function runOAuthFlows(instances, composeCmd) {
    const oauthInstances = instances.filter(i => i.authMethod === 'oauth');
    if (oauthInstances.length === 0) return;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🔐 OAuth Authentication (${oauthInstances.length} instance${oauthInstances.length > 1 ? 's' : ''})`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`\nEach OAuth instance needs to authenticate with a Google account.`);
    console.log(`The Gemini CLI will provide a URL — open it in your browser,`);
    console.log(`sign in, and paste the authorization code back here.\n`);

    console.log(`\n⚠️ IMPORTANT: Manual OAuth Authentication Required ⚠️`);
    console.log(`For each of the following instances, open a NEW terminal window and run its command.`);
    console.log(`This will present you with the login URL. Sign in and the credentials will be saved.\n`);

    for (const inst of oauthInstances) {
        const serviceName = `ionosphere-${inst.name}`;
        console.log(`To authenticate ${inst.name}:`);
        const engine = composeCmd.includes('docker') ? 'docker' : 'podman';
        console.log(`  ${engine} exec -it -e CI=false ${serviceName} bash -c "trap 'stty sane' EXIT; gemini auth login"`);
    }
    console.log(`\nOnce you have authenticated all required instances, you can start the application.`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`${'═'.repeat(60)}`);
    console.log(`  🚀 Ionosphere Multi-Instance Setup`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`\nThis tool generates a Docker Compose file and per-instance`);
    console.log(`environment configs for running multiple Ionosphere sessions`);
    console.log(`in parallel — each with its own auth, port, and workspace.\n`);

    // ── Check for existing multi-instance config ──
    if (fs.existsSync(COMPOSE_OUTPUT)) {
        const { overwrite } = await inquirer.prompt([{
            type: 'confirm',
            name: 'overwrite',
            message: `${COMPOSE_OUTPUT} already exists. Overwrite?`,
            default: false
        }]);

        if (!overwrite) {
            console.log('Aborted. Existing configuration preserved.');
            return;
        }
    }

    // ── Detect container runtime ──
    const composeCmd = detectComposeCmd();
    if (!composeCmd) {
        console.error('❌ Neither Docker nor Podman detected. Install one to use multi-instance mode.');
        process.exit(1);
    }
    console.log(`✅ Container runtime: ${composeCmd}\n`);

    // ── Collect global preferences ──
    console.log(`${'─'.repeat(50)}`);
    console.log(`  ⚙️  Global Preferences (shared across all instances)`);
    console.log(`${'─'.repeat(50)}\n`);

    const globalPrefs = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'disableTelemetry',
            message: 'Disable telemetry?',
            default: true
        },
        {
            type: 'confirm',
            name: 'enablePreview',
            message: 'Enable preview models?',
            default: true
        },
        {
            type: 'confirm',
            name: 'disableTools',
            message: "Disable Gemini's inbuilt tools? (recommended for custom tool workflows)",
            default: true
        },
        {
            type: 'confirm',
            name: 'disableWebSearch',
            message: 'Disable Google Web Search tool as well?',
            default: false
        },
        {
            type: 'confirm',
            name: 'silentFallback',
            message: 'Enable silent model fallbacks? (auto-switch on model failure)',
            default: true
        }
    ]);

    // ── Nginx public exposure ──
    const { enableNginx } = await inquirer.prompt([{
        type: 'confirm',
        name: 'enableNginx',
        message: 'Expose publicly via Nginx reverse proxy? (generates nginx-ionosphere.conf)',
        default: false
    }]);

    let nginxPrefs = null;
    if (enableNginx) {
        nginxPrefs = await inquirer.prompt([
            {
                type: 'input',
                name: 'hostname',
                message: 'Public hostname or IP-based sslip.io address\n  (e.g. 2001-db8--1.sslip.io or yourdomain.com):',
                validate: (v) => v.trim().length > 0 ? true : 'Hostname is required'
            },
            {
                type: 'list',
                name: 'routingMode',
                message: 'How to expose multiple instances?',
                choices: [
                    { name: 'Primary only  — first instance on 443, rest are localhost-only', value: 'primary_only' },
                    { name: 'Multi-port   — each instance on its own HTTPS port (443, 8443, 9443…)', value: 'multi_port' },
                ]
            },
            {
                type: 'list',
                name: 'selfSigned',
                message: 'TLS certificate:',
                choices: [
                    { name: "Self-signed (works now, clients need --insecure or cert trust)", value: true },
                    { name: "Let's Encrypt (requires ports 80 & 443 open in your cloud firewall)", value: false },
                ]
            }
        ]);
        nginxPrefs.hostname = nginxPrefs.hostname.trim();
    }

    // ── Collect per-instance configs ──
    const instances = await collectInstances();

    // ── Generate files ──
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  📝 Generating Configuration Files`);
    console.log(`${'═'.repeat(60)}\n`);

    // Write per-instance .env files
    for (const inst of instances) {
        const envPath = `${ENV_PREFIX}${inst.name}`;
        const envContent = generateEnvFile(inst, globalPrefs);
        fs.writeFileSync(envPath, envContent, 'utf-8');
        console.log(`  ✅ ${envPath}`);
    }

    // Write docker-compose.multi.yml
    const composeContent = generateComposeFile(instances, !!nginxPrefs);
    fs.writeFileSync(COMPOSE_OUTPUT, composeContent, 'utf-8');
    console.log(`  ✅ ${COMPOSE_OUTPUT}`);

    // Write nginx config if requested
    const NGINX_OUTPUT = 'nginx-ionosphere.conf';
    if (nginxPrefs) {
        const nginxContent = generateNginxConfig(instances, nginxPrefs);
        fs.writeFileSync(NGINX_OUTPUT, nginxContent, 'utf-8');
        console.log(`  ✅ ${NGINX_OUTPUT}`);
    }

    // Create temp directories
    for (const inst of instances) {
        const tempDir = path.join('temp', inst.name);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
    }
    console.log(`  ✅ temp/ subdirectories`);

    // ── Add to .gitignore ──
    const gitignorePath = '.gitignore';
    if (fs.existsSync(gitignorePath)) {
        let gitignore = fs.readFileSync(gitignorePath, 'utf-8');
        const additions = [];
        if (!gitignore.includes('.env.instance-')) additions.push('.env.instance-*');
        if (!gitignore.includes('docker-compose.multi.yml')) additions.push('docker-compose.multi.yml');
        if (nginxPrefs && !gitignore.includes('nginx-ionosphere.conf')) additions.push('nginx-ionosphere.conf');

        if (additions.length > 0) {
            gitignore += `\n# Multi-instance generated files\n${additions.join('\n')}\n`;
            fs.writeFileSync(gitignorePath, gitignore, 'utf-8');
            console.log(`  ✅ .gitignore updated`);
        }
    }

    // ── Build the image ──
    const { buildNow } = await inquirer.prompt([{
        type: 'confirm',
        name: 'buildNow',
        message: 'Build the Docker image now?',
        default: true
    }]);

    if (buildNow) {
        console.log(`\n🏗️  Building Ionosphere image...`);
        console.log(`⏳ (This may take a few minutes for the first build)\n`);

        const buildArgs = `--build-arg GEMINI_DISABLE_TOOLS=${globalPrefs.disableTools ? 'true' : 'false'} --build-arg GEMINI_DISABLE_WEB_SEARCH=${globalPrefs.disableWebSearch ? 'true' : 'false'}`;
        const buildResult = spawnSync(`${composeCmd} -f ${COMPOSE_OUTPUT} build ${buildArgs}`, {
            stdio: 'inherit',
            shell: true
        });

        if (buildResult.status !== 0) {
            console.error(`\n❌ Build failed. Fix the errors above and re-run.`);
            process.exit(1);
        }
        console.log(`✅ Image built successfully.\n`);
    }

    // ── Summary ──
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  🎉 Multi-Instance Setup Complete!`);
    console.log(`${'═'.repeat(60)}\n`);

    // Summary table
    const maxNameLen = Math.max(...instances.map(i => i.name.length), 4);
    const header = `  ${'Name'.padEnd(maxNameLen)}  Port   Auth       API Key (Bridge)`;
    const divider = `  ${'─'.repeat(maxNameLen)}  ${'─'.repeat(5)}  ${'─'.repeat(9)}  ${'─'.repeat(52)}`;

    console.log(header);
    console.log(divider);

    for (const inst of instances) {
        const auth = inst.authMethod === 'oauth' ? 'OAuth' : 'API Key';
        console.log(`  ${inst.name.padEnd(maxNameLen)}  ${String(inst.port).padEnd(5)}  ${auth.padEnd(9)}  ${inst.bridgeKey}`);
    }

    const upArgs = composeCmd === 'podman-compose' ? '--podman-run-args="--replace" up -d' : 'up -d';

    console.log(`\n📋 Quick Reference:\n`);
    console.log(`  Start all:   ${composeCmd} -f ${COMPOSE_OUTPUT} ${upArgs}`);
    console.log(`  View logs:   ${composeCmd} -f ${COMPOSE_OUTPUT} logs -f`);
    console.log(`  Stop all:    ${composeCmd} -f ${COMPOSE_OUTPUT} down`);
    console.log(`  Restart one: ${composeCmd} -f ${COMPOSE_OUTPUT} restart ionosphere-<name>`);
    console.log(``);

    if (nginxPrefs) {
        const { hostname, routingMode } = nginxPrefs;
        const httpsPorts = [443, 8443, 9443, 10443, 11443];
        console.log(`  🌐 Public endpoints (via Nginx):`);
        if (routingMode === 'primary_only') {
            const primary = instances[0];
            console.log(`  📡 ${primary.name}: https://${hostname}/v1/chat/completions`);
            for (const inst of instances.slice(1)) {
                console.log(`  📡 ${inst.name}: http://localhost:${inst.port}/v1/chat/completions  (localhost only)`);
            }
        } else {
            for (let i = 0; i < instances.length; i++) {
                const inst = instances[i];
                const port = httpsPorts[i] ?? (8000 + i);
                const portSuffix = port === 443 ? '' : `:${port}`;
                console.log(`  📡 ${inst.name}: https://${hostname}${portSuffix}/v1/chat/completions`);
            }
        }
        console.log(``);
        console.log(`  📄 Nginx config: nginx-ionosphere.conf`);
        console.log(`     Install: sudo cp nginx-ionosphere.conf /etc/nginx/sites-available/ionosphere`);
        console.log(`              sudo ln -sf /etc/nginx/sites-available/ionosphere /etc/nginx/sites-enabled/ionosphere`);
        console.log(`              sudo nginx -t && sudo systemctl reload nginx`);
        if (!nginxPrefs.selfSigned) {
            console.log(`  🔒 TLS cert: sudo certbot --nginx -d ${hostname} --non-interactive --agree-tos --register-unsafely-without-email`);
            console.log(`     Requires ports 80 & 443 open in your cloud security group first.`);
        } else {
            console.log(`  🔒 Self-signed cert — generate once on the host:`);
            console.log(`     sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \\`);
            console.log(`       -keyout /etc/ssl/private/ionosphere-selfsigned.key \\`);
            console.log(`       -out /etc/ssl/certs/ionosphere-selfsigned.crt \\`);
            console.log(`       -subj "/CN=${hostname}"`);
        }
    } else {
        for (const inst of instances) {
            console.log(`  📡 ${inst.name}: http://localhost:${inst.port}/v1/chat/completions`);
        }
    }

    console.log(`\n💡 Use these endpoints in your OpenAI-compatible clients.`);
    console.log(`   Each instance's Bridge API Key is in its .env.instance-<name> file.\n`);

    // ── Offer to start ──
    const { startNow } = await inquirer.prompt([{
        type: 'confirm',
        name: 'startNow',
        message: 'Launch all instances now?',
        default: false
    }]);

    if (startNow) {
        console.log(`\n🚀 Launching ${instances.length} instance(s)...\n`);
        const upResult = spawnSync(`${composeCmd} -f ${COMPOSE_OUTPUT} ${upArgs}`, {
            stdio: 'inherit',
            shell: true
        });

        if (upResult.status === 0) {
            console.log(`\n✅ All instances are running!`);
            console.log(`📝 View logs: ${composeCmd} -f ${COMPOSE_OUTPUT} logs -f\n`);
            
            if (buildNow) {
                // ── Run OAuth flows now that containers exist ──
                await runOAuthFlows(instances, composeCmd);
            }
        } else {
            console.error(`\n❌ Failed to launch. Check the errors above.`);
        }
    } else {
        if (buildNow) {
            console.log(`\n✅ Setup complete! You can start the instances later by running:`);
            console.log(`   ${composeCmd} -f ${COMPOSE_OUTPUT} ${upArgs}`);
            // Instruct user they still need to auth when they start them
            await runOAuthFlows(instances, composeCmd);
        }
    }
}
export { main };

// Auto-run when executed directly (not imported)
const isDirectRun = process.argv[1] &&
    (process.argv[1].endsWith('setup-multi.js') ||
     process.argv[1].endsWith('setup-multi'));

if (isDirectRun) {
    main().catch(err => {
        console.error('Setup failed:', err);
        process.exit(1);
    });
}
