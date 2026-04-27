const DEFAULT_REPO = 'Arnbeater/printforsider';
const DEFAULT_BRANCH = 'master';
const DEFAULT_PATH = 'data/progress_state.json';

function json(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function decodeBase64(value) {
  return Buffer.from(value || '', 'base64').toString('utf8');
}

function encodeBase64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function githubRequest(url, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { response, data };
}

async function getProgressFile({ repo, branch, path }) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const { response, data } = await githubRequest(url);

  if (response.status === 404) {
    return { exists: false, sha: null, progress: { version: 1, state: {}, updatedAt: null } };
  }

  if (!response.ok) {
    throw new Error(`GitHub read failed: ${response.status} ${data?.message || ''}`);
  }

  const progress = JSON.parse(decodeBase64(data.content));
  return { exists: true, sha: data.sha, progress };
}

async function saveProgressFile({ repo, branch, path, sha, progress }) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${repo}/contents/${encodedPath}`;
  const body = {
    message: `Autosave print progress ${new Date().toISOString()}`,
    content: encodeBase64(JSON.stringify(progress, null, 2)),
    branch
  };

  if (sha) body.sha = sha;

  const { response, data } = await githubRequest(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`GitHub save failed: ${response.status} ${data?.message || ''}`);
  }

  return data;
}

export default async function handler(req, res) {
  if (!process.env.GITHUB_TOKEN) {
    return json(res, 503, { ok: false, error: 'GITHUB_TOKEN is not configured in Vercel.' });
  }

  const repo = process.env.GITHUB_REPO || DEFAULT_REPO;
  const branch = process.env.GITHUB_BRANCH || DEFAULT_BRANCH;
  const path = process.env.PROGRESS_PATH || DEFAULT_PATH;

  try {
    if (req.method === 'GET') {
      const file = await getProgressFile({ repo, branch, path });
      return json(res, 200, { ok: true, progress: file.progress, exists: file.exists });
    }

    if (req.method === 'POST') {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const incomingState = body.state;

      if (!incomingState || typeof incomingState !== 'object' || Array.isArray(incomingState)) {
        return json(res, 400, { ok: false, error: 'Expected body.state object.' });
      }

      const file = await getProgressFile({ repo, branch, path });
      const progress = {
        version: 1,
        app: 'printforsider',
        updatedAt: new Date().toISOString(),
        state: incomingState
      };

      const saved = await saveProgressFile({ repo, branch, path, sha: file.sha, progress });
      return json(res, 200, { ok: true, updatedAt: progress.updatedAt, commit: saved.commit?.sha || null });
    }

    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, error: 'Method not allowed.' });
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: error.message || 'Unknown server error.' });
  }
}
