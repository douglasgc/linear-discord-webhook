#!/usr/bin/env node
// Backup + arquivamento das issues de ciclos já encerrados, pra ficar abaixo do
// limite de issues do plano free do Linear. Issues do ciclo atual e sem ciclo
// nunca são tocadas.
//
// Usa a autenticação da CLI `linear` (rode `linear auth login` uma vez) e da
// AWS CLI. Bucket/perfil vêm de .env.backup na raiz do repo (veja .env.backup.example)
// ou das variáveis LINEAR_BACKUP_BUCKET, LINEAR_BACKUP_PREFIX e LINEAR_BACKUP_AWS_PROFILE.
//
// Estrutura gerada (local em backups/linear/ e no S3 em s3://<bucket>/<prefix>/):
//   ciclo-02_2026-10-28_a_2026-11-10/
//     README.md                      índice do ciclo, agrupado por time
//     issues.json                    dados completos (pra reimportar/processar)
//     ENG/ENG-42_titulo-da-issue.md
//
// Uso:
//   node scripts/linear-backup.mjs [opções]
//
// Opções:
//   --states <lista>     Tipos de estado a incluir (padrão: completed,canceled).
//                        Valores: backlog, unstarted, started, completed, canceled, triage
//   --team <KEY>         Restringe a um time (ex.: ENG)
//   --workspace <slug>   Workspace da CLI linear (padrão: o default da CLI)
//   --out <dir>          Pasta local de saída (padrão: backups/linear)
//   --bucket <nome>      Bucket S3 (padrão: $LINEAR_BACKUP_BUCKET)
//   --prefix <prefixo>   Prefixo no bucket (padrão: $LINEAR_BACKUP_PREFIX ou linear-backups)
//   --aws-profile <nome> Perfil da AWS CLI (padrão: $LINEAR_BACKUP_AWS_PROFILE ou o default)
//   --no-upload          Não envia pro S3
//   --archive            Arquiva as issues depois do backup (não contam no limite)
//   --delete             Manda as issues pra lixeira depois do backup (30 dias pra recuperar)
//   --yes                Não pede confirmação
//
// Sem --archive/--delete o script só faz o backup (dry run). Com --archive/--delete,
// só mexe no Linear depois de confirmar que o upload pro S3 está completo.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PAGE_SIZE = 25;

// Configuração local (fora do git): .env.backup na raiz do repo.
try {
	process.loadEnvFile(new URL('../.env.backup', import.meta.url));
} catch {}

const TIMEZONE = process.env.LINEAR_BACKUP_TIMEZONE || 'America/Sao_Paulo';

function parseArgs(argv) {
	const opts = {
		states: ['completed', 'canceled'],
		workspace: null,
		team: null,
		out: 'backups/linear',
		bucket: process.env.LINEAR_BACKUP_BUCKET || null,
		prefix: (process.env.LINEAR_BACKUP_PREFIX || 'linear-backups').replace(
			/^\/+|\/+$/g,
			''
		),
		awsProfile:
			process.env.LINEAR_BACKUP_AWS_PROFILE || process.env.AWS_PROFILE || null,
		upload: true,
		action: null,
		yes: false
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`Faltou valor para ${arg}`);
			return value;
		};
		switch (arg) {
			case '--states':
				opts.states = next()
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean);
				break;
			case '--workspace':
				opts.workspace = next();
				break;
			case '--team':
				opts.team = next();
				break;
			case '--out':
				opts.out = next();
				break;
			case '--bucket':
				opts.bucket = next();
				break;
			case '--prefix':
				opts.prefix = next().replace(/^\/+|\/+$/g, '');
				break;
			case '--aws-profile':
				opts.awsProfile = next();
				break;
			case '--no-upload':
				opts.upload = false;
				break;
			case '--archive':
			case '--delete':
				if (opts.action)
					throw new Error('Use só um entre --archive e --delete');
				opts.action = arg.slice(2);
				break;
			case '--yes':
				opts.yes = true;
				break;
			case '-h':
			case '--help':
				console.log(
					'Uso: node scripts/linear-backup.mjs [--states completed,canceled] [--team KEY] [--workspace slug] [--out dir] [--bucket nome] [--prefix p] [--aws-profile nome] [--no-upload] [--archive|--delete] [--yes]'
				);
				process.exit(0);
			default:
				throw new Error(`Opção desconhecida: ${arg}`);
		}
	}
	return opts;
}

let workspace = null;

// Envia a query pela CLI `linear`, que já cuida da autenticação.
async function gql(query, variables = {}, attempt = 1) {
	const args = [
		'api',
		'--no-input',
		'--variables-json',
		JSON.stringify(variables)
	];
	if (workspace) args.push('--workspace', workspace);
	args.push(query);
	try {
		const { stdout } = await run('linear', args, {
			maxBuffer: 256 * 1024 * 1024
		});
		const body = JSON.parse(stdout);
		if (body.errors)
			throw new Error(body.errors.map((e) => e.message).join('; '));
		return body.data;
	} catch (err) {
		if (err.code === 'ENOENT')
			throw new Error('CLI `linear` não encontrada no PATH.');
		const msg = (err.stderr || err.message || '').trim();
		if (attempt < 4 && /rate|limit|timeout|ECONN|5\d\d/i.test(msg)) {
			console.warn(`  ⏳ ${msg} — tentando de novo em ${5 * attempt}s...`);
			await new Promise((r) => setTimeout(r, 5000 * attempt));
			return gql(query, variables, attempt + 1);
		}
		throw new Error(`Linear: ${msg}`);
	}
}

const ISSUE_FIELDS = `
	id identifier title description url priority priorityLabel estimate
	createdAt updatedAt startedAt completedAt canceledAt dueDate archivedAt
	state { name type }
	team { key name }
	creator { name email }
	assignee { name email }
	project { name }
	cycle { number name startsAt endsAt }
	parent { identifier title }
	labels(first: 25) { nodes { name } }
	attachments(first: 25) { nodes { title url subtitle createdAt } }
	comments(first: 50) {
		pageInfo { hasNextPage endCursor }
		nodes { body createdAt user { name } }
	}
`;

const ISSUES_QUERY = `
	query Issues($filter: IssueFilter, $after: String) {
		issues(filter: $filter, first: ${PAGE_SIZE}, after: $after, orderBy: createdAt) {
			pageInfo { hasNextPage endCursor }
			nodes { ${ISSUE_FIELDS} }
		}
	}
`;

const MORE_COMMENTS_QUERY = `
	query MoreComments($id: String!, $after: String) {
		issue(id: $id) {
			comments(first: 100, after: $after) {
				pageInfo { hasNextPage endCursor }
				nodes { body createdAt user { name } }
			}
		}
	}
`;

function buildFilter(opts) {
	// Só issues em ciclos já encerrados: o ciclo atual e issues sem ciclo ficam de fora.
	const filter = {
		cycle: { isPast: { eq: true } },
		state: { type: { in: opts.states } }
	};
	if (opts.team) filter.team = { key: { eq: opts.team } };
	return filter;
}

async function fetchIssues(filter) {
	const issues = [];
	let after = null;
	do {
		const { issues: page } = await gql(ISSUES_QUERY, { filter, after });
		for (const issue of page.nodes) {
			let { pageInfo } = issue.comments;
			while (pageInfo.hasNextPage) {
				const { issue: more } = await gql(MORE_COMMENTS_QUERY, {
					id: issue.id,
					after: pageInfo.endCursor
				});
				issue.comments.nodes.push(...more.comments.nodes);
				pageInfo = more.comments.pageInfo;
			}
			issues.push(flatten(issue));
		}
		process.stdout.write(`\r  ${issues.length} issues lidas...`);
		after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
	} while (after);
	process.stdout.write('\n');
	return issues;
}

function flatten(issue) {
	return {
		...issue,
		labels: issue.labels.nodes.map((l) => l.name),
		attachments: issue.attachments.nodes,
		comments: issue.comments.nodes.sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt)
		)
	};
}

function toMarkdown(issue) {
	const lines = [
		`# ${issue.identifier} — ${issue.title}`,
		'',
		`- **Status:** ${issue.state?.name ?? '-'} (${issue.state?.type ?? '-'})`,
		`- **Time:** ${issue.team?.name ?? '-'}`,
		`- **Responsável:** ${issue.assignee?.name ?? '-'}`,
		`- **Criada por:** ${issue.creator?.name ?? '-'} em ${issue.createdAt}`,
		`- **Prioridade:** ${issue.priorityLabel ?? '-'}`,
		issue.project ? `- **Projeto:** ${issue.project.name}` : null,
		issue.cycle
			? `- **Ciclo:** ${issue.cycle.number} (${cycleRange(issue.cycle)})`
			: null,
		issue.parent
			? `- **Pai:** ${issue.parent.identifier} — ${issue.parent.title}`
			: null,
		issue.labels.length ? `- **Labels:** ${issue.labels.join(', ')}` : null,
		issue.completedAt ? `- **Concluída em:** ${issue.completedAt}` : null,
		issue.canceledAt ? `- **Cancelada em:** ${issue.canceledAt}` : null,
		`- **Link original:** ${issue.url}`,
		'',
		'## Descrição',
		'',
		issue.description?.trim() || '_Sem descrição._'
	].filter((l) => l !== null);

	if (issue.attachments.length) {
		lines.push('', '## Anexos', '');
		for (const a of issue.attachments)
			lines.push(`- [${a.title || a.url}](${a.url})`);
	}
	if (issue.comments.length) {
		lines.push('', '## Comentários');
		for (const c of issue.comments) {
			lines.push(
				'',
				`### ${c.user?.name ?? 'Desconhecido'} — ${c.createdAt}`,
				'',
				c.body
			);
		}
	}
	return lines.join('\n') + '\n';
}

const localDate = (iso) =>
	new Date(iso).toLocaleDateString('en-CA', { timeZone: TIMEZONE });
// endsAt é exclusivo (meia-noite do dia seguinte), então o último dia é 1ms antes.
const cycleRange = (c) =>
	`${localDate(c.startsAt)} a ${localDate(new Date(new Date(c.endsAt) - 1).toISOString())}`;
const cycleDirName = (c) =>
	`ciclo-${String(c.number).padStart(2, '0')}_${cycleRange(c).replace(' a ', '_a_')}`;

function slugify(text, max = 60) {
	const slug = text
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug.slice(0, max).replace(/-+$/, '') || 'sem-titulo';
}

const issueFile = (issue) =>
	join(issue.team.key, `${issue.identifier}_${slugify(issue.title)}.md`);
const cell = (text) =>
	String(text ?? '')
		.replace(/\|/g, '\\|')
		.replace(/\n/g, ' ');

function cycleReadme(dirName, cycle, issues) {
	const lines = [
		`# Backup Linear — Ciclo ${cycle.number} (${cycleRange(cycle)})`,
		''
	];
	lines.push(
		`${issues.length} issues · gerado em ${new Date().toLocaleString('pt-BR', { timeZone: TIMEZONE })}`
	);
	const byTeam = Map.groupBy(issues, (i) => `${i.team.name} (${i.team.key})`);
	for (const [team, list] of [...byTeam].sort(([a], [b]) =>
		a.localeCompare(b)
	)) {
		lines.push(
			'',
			`## ${team} — ${list.length}`,
			'',
			'| Issue | Título | Status | Responsável | Projeto |',
			'| --- | --- | --- | --- | --- |'
		);
		for (const i of list) {
			lines.push(
				`| [${i.identifier}](${encodeURI(issueFile(i))}) | ${cell(i.title)} | ${cell(i.state?.name)} | ${cell(i.assignee?.name ?? '-')} | ${cell(i.project?.name ?? '-')} |`
			);
		}
	}
	return lines.join('\n') + '\n';
}

// Grava uma pasta por ciclo. Se a pasta já existir (rodada anterior), junta com o que já tinha.
async function writeBackup(issues, outRoot) {
	const byCycle = Map.groupBy(issues, (i) => cycleDirName(i.cycle));
	const dirs = [];
	for (const [dirName, cycleIssues] of byCycle) {
		const dir = join(outRoot, dirName);
		const jsonPath = join(dir, 'issues.json');
		const previous = JSON.parse(
			await readFile(jsonPath, 'utf8').catch(() => '[]')
		);
		const merged = [
			...new Map([...previous, ...cycleIssues].map((i) => [i.id, i])).values()
		].sort((a, b) =>
			a.identifier.localeCompare(b.identifier, 'en', { numeric: true })
		);

		for (const issue of cycleIssues) {
			await mkdir(join(dir, issue.team.key), { recursive: true });
			await writeFile(join(dir, issueFile(issue)), toMarkdown(issue));
		}
		await writeFile(jsonPath, JSON.stringify(merged, null, 2));
		await writeFile(
			join(dir, 'README.md'),
			cycleReadme(dirName, cycleIssues[0].cycle, merged)
		);

		// Confere que o backup foi gravado inteiro antes de mexer em qualquer coisa no Linear.
		const saved = new Set(
			JSON.parse(await readFile(jsonPath, 'utf8')).map((i) => i.id)
		);
		if (!cycleIssues.every((i) => saved.has(i.id)))
			throw new Error(`Backup incompleto em ${dir}, abortando.`);
		dirs.push({ dir, dirName, count: cycleIssues.length });
	}
	return dirs;
}

async function countFiles(dir) {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries.filter((e) => e.isFile()).length;
}

async function aws(args, profile) {
	try {
		const { stdout } = await run('aws', args, {
			env: profile ? { ...process.env, AWS_PROFILE: profile } : process.env,
			maxBuffer: 64 * 1024 * 1024
		});
		return stdout;
	} catch (err) {
		if (err.code === 'ENOENT')
			throw new Error('AWS CLI não encontrada no PATH.');
		const msg = (err.stderr || err.message || '').trim();
		if (/sso|expired|Token|credentials/i.test(msg)) {
			throw new Error(
				`Sessão AWS expirada ou ausente. Rode: aws sso login${profile ? ` --profile ${profile}` : ''}\n${msg}`
			);
		}
		throw new Error(`AWS: ${msg}`);
	}
}

// Sobe cada pasta de ciclo e confere que todos os arquivos chegaram no bucket.
async function uploadBackup(dirs, opts) {
	for (const { dir, dirName } of dirs) {
		const target = `s3://${opts.bucket}/${opts.prefix}/${dirName}/`;
		await aws(
			['s3', 'sync', dir, target, '--sse', 'AES256', '--only-show-errors'],
			opts.awsProfile
		);
		const listing = await aws(
			['s3', 'ls', target, '--recursive'],
			opts.awsProfile
		);
		const remote = listing.split('\n').filter(Boolean).length;
		const local = await countFiles(dir);
		if (remote < local)
			throw new Error(
				`Upload incompleto em ${target} (${remote}/${local} arquivos).`
			);
		console.log(`  ☁️  ${target} (${local} arquivos)`);
	}
}

async function confirm(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await rl.question(question);
	rl.close();
	return /^(s|sim|y|yes)$/i.test(answer.trim());
}

async function applyAction(issues, action) {
	const mutation =
		action === 'archive'
			? 'mutation($id: String!) { issueArchive(id: $id) { success } }'
			: 'mutation($id: String!) { issueDelete(id: $id) { success } }';
	const failed = [];
	for (const [n, issue] of issues.entries()) {
		try {
			const data = await gql(mutation, { id: issue.id });
			const ok =
				action === 'archive'
					? data.issueArchive.success
					: data.issueDelete.success;
			if (!ok) throw new Error('success=false');
		} catch (err) {
			failed.push({ identifier: issue.identifier, error: err.message });
		}
		process.stdout.write(`\r  ${n + 1}/${issues.length} processadas...`);
	}
	process.stdout.write('\n');
	return failed;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	workspace = opts.workspace;
	if (opts.upload && !opts.bucket) {
		throw new Error(
			'Defina LINEAR_BACKUP_BUCKET (em .env.backup) ou use --bucket, ou rode com --no-upload.'
		);
	}

	const { viewer } = await gql('{ viewer { name organization { name } } }');
	console.log(`Conectado como ${viewer.name} em ${viewer.organization.name}`);
	console.log(
		`Filtro: ciclos encerrados, estados=${opts.states.join(',')}` +
			(opts.team ? ` time=${opts.team}` : '')
	);

	console.log('Buscando issues...');
	const issues = await fetchIssues(buildFilter(opts));
	if (issues.length === 0) {
		console.log('Nenhuma issue encontrada com esse filtro.');
		return;
	}

	const dirs = await writeBackup(issues, opts.out);
	for (const d of dirs) console.log(`✅ ${d.count} issues salvas em ${d.dir}`);

	if (opts.upload) {
		console.log('Enviando pro S3...');
		await uploadBackup(dirs, opts);
	}

	if (!opts.action) {
		console.log(
			'Dry run: nada foi alterado no Linear. Rode com --archive ou --delete para liberar espaço.'
		);
		return;
	}

	const verb = opts.action === 'archive' ? 'ARQUIVAR' : 'MANDAR PRA LIXEIRA';
	if (
		!opts.yes &&
		!(await confirm(
			`Vai ${verb} ${issues.length} issues no Linear. Continuar? (s/N) `
		))
	) {
		console.log('Cancelado. O backup continua salvo.');
		return;
	}

	const failed = await applyAction(issues, opts.action);
	if (failed.length) {
		const failedPath = join(opts.out, `failed-${Date.now()}.json`);
		await writeFile(failedPath, JSON.stringify(failed, null, 2));
		console.log(`⚠️  ${failed.length} falharam (detalhes em ${failedPath}).`);
	}
	console.log(
		`✅ ${issues.length - failed.length} issues ${opts.action === 'archive' ? 'arquivadas' : 'enviadas pra lixeira'}.`
	);
}

main().catch((err) => {
	console.error(`❌ ${err.message}`);
	process.exit(1);
});
