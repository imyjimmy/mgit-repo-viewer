const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const https = require('https');
const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const jwt = require('jsonwebtoken');

// nostr
const { verifyEvent, validateEvent, getEventHash } = require('nostr-tools');

// Import security configuration
const configureSecurity = require('./security');

const app = express();
app.use(express.json());
app.use(cors());

// Apply security configurations
const security = configureSecurity(app);

// JWT secret key for authentication tokens
const JWT_SECRET = process.env.JWT_SECRET || 'mgit-jwt-secret-key-change-in-production';

// Path to repositories storage - secure path verified by security module
const REPOS_PATH = security.ensureSecurePath();

// Store pending challenges in memory (use a database in production)
const pendingChallenges = new Map();

// Auth middleware
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(' ')[1];

    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        return res.status(403).json({ status: 'error', reason: 'Invalid or expired token' });
      }

      req.user = user;
      next();
    });
  } else {
    res.status(401).json({ status: 'error', reason: 'No authentication token provided' });
  }
};

// Ensure repositories directory exists
if (!fs.existsSync(REPOS_PATH)) {
  fs.mkdirSync(REPOS_PATH, { recursive: true });
}

app.get('/api/auth/:type/status', (req, res) => {
  const { type } = req.params;
  const { k1 } = req.query;
  
  console.log(`Status check for ${type}:`, k1);
  
  if (!pendingChallenges.has(k1)) {
    return res.status(400).json({ status: 'error', reason: 'Challenge not found' });
  }

  const challenge = pendingChallenges.get(k1);
  console.log('Challenge status:', challenge);

  res.json({
    status: challenge.verified ? 'verified' : 'pending',
    nodeInfo: challenge.verified ? {
      pubkey: challenge.pubkey
    } : null
  });
});

/* 
* NOSTR Login additions
*/
app.post('/api/auth/nostr/challenge', (req, res) => {
  const challenge = crypto.randomBytes(32).toString('hex');
  
  pendingChallenges.set(challenge, {
    timestamp: Date.now(),
    verified: false,
    pubkey: null,
    type: 'nostr'
  });

  console.log('Generated Nostr challenge:', challenge);

  res.json({
    challenge,
    tag: 'login'
  });
});

app.post('/api/auth/nostr/verify', async (req, res) => {
  const { signedEvent } = req.body;
  
  try {
    // Validate the event format
    if (!validateEvent(signedEvent)) {
      return res.status(400).json({ 
        status: 'error', 
        reason: 'Invalid event format' 
      });
    }

    // Verify the event signature
    if (!verifyEvent(signedEvent)) {
      return res.status(400).json({ 
        status: 'error', 
        reason: 'Invalid signature' 
      });
    }

    // Create WebSocket connection to get metadata
    const ws = new WebSocket('wss://relay.damus.io');
    
    const metadataPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Metadata fetch timeout'));
      }, 5000);

      ws.onopen = () => {
        const req = JSON.stringify([
          "REQ",
          "metadata-query",
          {
            "kinds": [0],
            "authors": [signedEvent.pubkey],
            "limit": 1
          }
        ]);
        ws.send(req);
      };

      ws.onmessage = (event) => {
        const [type, _, eventData] = JSON.parse(event.data);
        if (type === 'EVENT' && eventData.kind === 0) {
          clearTimeout(timeout);
          ws.close();
          resolve(eventData);
        }
      };

      ws.onerror = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
    });

    let metadata = null;
    try {
      metadata = await metadataPromise;
    } catch (error) {
      console.warn('Failed to fetch Nostr metadata:', error.message);
      // Continue without metadata
    }
    
    // Generate JWT token
    const token = jwt.sign({ 
      pubkey: signedEvent.pubkey,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24) // 24 hour expiration
    }, JWT_SECRET);

    console.log('Nostr login verified for pubkey:', signedEvent.pubkey);
    res.json({ 
      status: 'OK',
      pubkey: signedEvent.pubkey,
      metadata,
      token
    });

  } catch (error) {
    console.error('Nostr verification error:', error);
    res.status(500).json({ 
      status: 'error', 
      reason: 'Verification failed' 
    });
  }
});

app.get('/api/auth/nostr/status', (req, res) => {
  const { challenge } = req.query;
  
  if (!pendingChallenges.has(challenge)) {
    return res.status(400).json({ 
      status: 'error', 
      reason: 'Challenge not found' 
    });
  }

  const challengeData = pendingChallenges.get(challenge);
  
  // Only return status for Nostr challenges
  if (challengeData.type !== 'nostr') {
    return res.status(400).json({ 
      status: 'error', 
      reason: 'Invalid challenge type' 
    });
  }

  res.json({
    status: challengeData.verified ? 'verified' : 'pending',
    userInfo: challengeData.verified ? {
      pubkey: challengeData.pubkey
    } : null
  });
});

app.get('/api/nostr/nip05/verify', async (req, res) => {
  const { domain, name } = req.query;

  if (!domain || !name) {
    return res.status(400).json({ error: 'Domain and name parameters are required' });
  }

  const agent = new https.Agent({
    rejectUnauthorized: false
  });

  try {
    const response = await axios.get(
      `https://nostr-check.com/.well-known/nostr.json?name=${name}`,
      { 
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        httpsAgent: agent
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error('NIP-05 verification error:', error.message);
    res.status(500).json({ error: error.message || 'Failed to verify NIP-05' });
  }
});

/*
 * MGit Repository API Endpoints
 */

// Get list of available repositories
app.get('/api/repos', authenticateJWT, (req, res) => {
  try {
    const repos = [];
    
    // Get directories in the repos path
    const owners = fs.readdirSync(REPOS_PATH, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    
    // For each owner, get their repositories
    owners.forEach(owner => {
      const ownerPath = path.join(REPOS_PATH, owner);
      const ownerRepos = fs.readdirSync(ownerPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
      
      // For each repo, get basic metadata
      ownerRepos.forEach(repoName => {
        const repoPath = path.join(ownerPath, repoName);
        
        // Skip if not an mgit repository
        if (!fs.existsSync(path.join(repoPath, '.mgit'))) {
          return;
        }
        
        try {
          // Get basic repo info using mgit commands
          const description = getRepoDescription(repoPath);
          const defaultBranch = getDefaultBranch(repoPath);
          const updatedAt = getLastCommitDate(repoPath);
          
          repos.push({
            id: `${owner}/${repoName}`,
            name: repoName,
            owner: owner,
            description: description,
            updated_at: updatedAt,
            default_branch: defaultBranch,
            // These could be computed from actual data in a real implementation
            stars: Math.floor(Math.random() * 50),
            forks: Math.floor(Math.random() * 20),
            license: getLicense(repoPath)
          });
        } catch (err) {
          console.error(`Error processing repo ${owner}/${repoName}:`, err);
        }
      });
    });
    
    res.json(repos);
  } catch (err) {
    console.error('Error listing repositories:', err);
    res.status(500).json({ error: 'Failed to list repositories' });
  }
});

// Get repository metadata
app.get('/api/repos/:owner/:repo', authenticateJWT, (req, res) => {
  const { owner, repo } = req.params;
  const repoPath = path.join(REPOS_PATH, owner, repo);
  
  try {
    if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.mgit'))) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    
    const defaultBranch = getDefaultBranch(repoPath);
    const description = getRepoDescription(repoPath);
    const updatedAt = getLastCommitDate(repoPath);
    const createdAt = getRepoCreationDate(repoPath);
    
    res.json({
      id: `${owner}/${repo}`,
      name: repo,
      owner: owner,
      full_name: `${owner}/${repo}`,
      description: description,
      default_branch: defaultBranch,
      created_at: createdAt,
      updated_at: updatedAt,
      stars: Math.floor(Math.random() * 50),
      forks: Math.floor(Math.random() * 20),
      watchers: Math.floor(Math.random() * 30),
      open_issues: Math.floor(Math.random() * 10),
      license: getLicense(repoPath)
    });
  } catch (err) {
    console.error(`Error getting repository ${owner}/${repo}:`, err);
    res.status(500).json({ error: 'Failed to get repository metadata' });
  }
});

// Get repository branches
app.get('/api/repos/:owner/:repo/branches', authenticateJWT, (req, res) => {
  const { owner, repo } = req.params;
  const repoPath = path.join(REPOS_PATH, owner, repo);
  
  try {
    if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.mgit'))) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    
    const defaultBranch = getDefaultBranch(repoPath);
    const branches = getBranches(repoPath);
    
    res.json(branches.map(branch => ({
      name: branch,
      isDefault: branch === defaultBranch
    })));
  } catch (err) {
    console.error(`Error getting branches for ${owner}/${repo}:`, err);
    res.status(500).json({ error: 'Failed to get repository branches' });
  }
});

// Get repository contents
app.get('/api/repos/:owner/:repo/contents', authenticateJWT, (req, res) => {
  const { owner, repo } = req.params;
  const { path: filePath = '', ref = '' } = req.query;
  
  // Validate path parameters to prevent path traversal attacks
  if (!security.validatePath(owner) || !security.validatePath(repo) || !security.validatePath(filePath)) {
    return res.status(400).json({ error: 'Invalid path parameters' });
  }
  
  const repoPath = path.join(REPOS_PATH, owner, repo);
  
  try {
    if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.mgit'))) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    
    const branch = ref || getDefaultBranch(repoPath);
    const contents = getRepoContents(repoPath, filePath, branch);
    
    res.json(contents);
  } catch (err) {
    console.error(`Error getting contents for ${owner}/${repo}:`, err);
    res.status(500).json({ error: 'Failed to get repository contents' });
  }
});

// Get file content
app.get('/api/repos/:owner/:repo/file', authenticateJWT, (req, res) => {
  const { owner, repo } = req.params;
  const { path: filePath, ref = '' } = req.query;
  
  // Validate path parameters to prevent path traversal attacks
  if (!security.validatePath(owner) || !security.validatePath(repo) || !security.validatePath(filePath)) {
    return res.status(400).json({ error: 'Invalid path parameters' });
  }
  
  const repoPath = path.join(REPOS_PATH, owner, repo);
  
  try {
    if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.mgit'))) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }
    
    const branch = ref || getDefaultBranch(repoPath);
    const fileContent = getFileContent(repoPath, filePath, branch);
    
    // Get file extension to determine content type
    const ext = path.extname(filePath).toLowerCase();
    const isBinary = isBinaryFile(ext);
    
    if (isBinary) {
      // For binary files, return a base64 encoded version
      const base64Content = Buffer.from(fileContent).toString('base64');
      res.json({
        content: base64Content,
        encoding: 'base64',
        size: Buffer.byteLength(fileContent),
        name: path.basename(filePath),
        path: filePath,
        sha: '', // Would normally compute this
        isBinary: true,
        type: 'file'
      });
    } else {
      // For text files, return the content directly
      res.json({
        content: fileContent,
        encoding: 'utf-8',
        size: Buffer.byteLength(fileContent),
        name: path.basename(filePath),
        path: filePath,
        sha: '', // Would normally compute this
        isBinary: false,
        type: 'file'
      });
    }
  } catch (err) {
    console.error(`Error getting file content for ${owner}/${repo}:`, err);
    res.status(500).json({ error: 'Failed to get file content' });
  }
});

// Get commit history
app.get('/api/repos/:owner/:repo/commits', authenticateJWT, (req, res) => {
  const { owner, repo } = req.params;
  const { ref = '', path: filePath = '' } = req.query;
  const repoPath = path.join(REPOS_PATH, owner, repo);
  
  try {
    if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.mgit'))) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    
    const branch = ref || getDefaultBranch(repoPath);
    const commits = getCommitHistory(repoPath, branch, filePath);
    
    res.json(commits);
  } catch (err) {
    console.error(`Error getting commit history for ${owner}/${repo}:`, err);
    res.status(500).json({ error: 'Failed to get commit history' });
  }
});

// Get specific commit detail
app.get('/api/repos/:owner/:repo/commits/:sha', authenticateJWT, (req, res) => {
  const { owner, repo, sha } = req.params;
  const repoPath = path.join(REPOS_PATH, owner, repo);
  
  try {
    if (!fs.existsSync(repoPath) || !fs.existsSync(path.join(repoPath, '.mgit'))) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    
    const commit = getCommitDetail(repoPath, sha);
    
    if (!commit) {
      return res.status(404).json({ error: 'Commit not found' });
    }
    
    res.json(commit);
  } catch (err) {
    console.error(`Error getting commit detail for ${owner}/${repo}:`, err);
    res.status(500).json({ error: 'Failed to get commit detail' });
  }
});

/*
 * Helper functions for MGit operations
 */

function getDefaultBranch(repoPath) {
  try {
    // We could make this actually use the mgit command, but for simplicity:
    // Try to find which branch HEAD points to
    const headPath = path.join(repoPath, '.mgit', 'HEAD');
    if (fs.existsSync(headPath)) {
      const headContent = fs.readFileSync(headPath, 'utf8').trim();
      const match = headContent.match(/ref: refs\/heads\/(.+)/);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    // Fallback to assuming main or master
    return 'main';
  } catch (err) {
    console.error('Error getting default branch:', err);
    return 'main'; // Default fallback
  }
}

function getBranches(repoPath) {
  try {
    // Use mgit branch command to list branches
    const output = execSync('mgit branch', { cwd: repoPath, encoding: 'utf8' });
    
    // Parse output to get branch names
    return output.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => line.replace(/^\*\s+/, '')); // Remove asterisk from current branch
  } catch (err) {
    console.error('Error getting branches:', err);
    return ['main']; // Default fallback
  }
}

function getRepoDescription(repoPath) {
  // Try to read description from README.md
  const readmePath = path.join(repoPath, 'README.md');
  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, 'utf8');
    const firstLine = readme.split('\n')[0];
    // Remove markdown heading markers
    return firstLine.replace(/^#+\s+/, '');
  }
  
  return 'No description available';
}

function getLastCommitDate(repoPath) {
  try {
    // Use mgit log to get last commit date
    const output = execSync('mgit log -1 --format=%cd', { cwd: repoPath, encoding: 'utf8' });
    return new Date(output.trim()).toISOString();
  } catch (err) {
    console.error('Error getting last commit date:', err);
    return new Date().toISOString(); // Fallback to current date
  }
}

function getRepoCreationDate(repoPath) {
  try {
    // Use mgit log to get first commit date
    const output = execSync('mgit log --reverse --format=%cd | head -1', { cwd: repoPath, encoding: 'utf8' });
    return new Date(output.trim()).toISOString();
  } catch (err) {
    console.error('Error getting repo creation date:', err);
    return new Date().toISOString(); // Fallback to current date
  }
}

function getLicense(repoPath) {
  // Check for common license files
  const licenseFiles = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE.md'];
  
  for (const file of licenseFiles) {
    const licensePath = path.join(repoPath, file);
    if (fs.existsSync(licensePath)) {
      const content = fs.readFileSync(licensePath, 'utf8');
      
      // Very simple license detection
      if (content.includes('MIT')) return 'MIT';
      if (content.includes('Apache License')) return 'Apache-2.0';
      if (content.includes('GNU GENERAL PUBLIC')) return 'GPL-3.0';
      
      return 'Other';
    }
  }
  
  return 'None';
}

function getRepoContents(repoPath, filePath, branch) {
  const fullPath = path.join(repoPath, filePath);
  
  // Check if path exists
  if (!fs.existsSync(fullPath)) {
    throw new Error('Path not found');
  }
  
  // Check if it's a directory
  const isDirectory = fs.statSync(fullPath).isDirectory();
  
  if (isDirectory) {
    // List directory contents
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    
    return entries.map(entry => {
      const entryPath = path.join(filePath, entry.name);
      
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: entryPath,
          type: 'dir',
          lastCommit: getLastCommitForPath(repoPath, entryPath)
        };
      } else {
        const stats = fs.statSync(path.join(repoPath, entryPath));
        
        return {
          name: entry.name,
          path: entryPath,
          type: 'file',
          size: stats.size,
          sha: '', // Would normally compute this
          lastCommit: getLastCommitForPath(repoPath, entryPath)
        };
      }
    });
  } else {
    // Return file content info
    const stats = fs.statSync(fullPath);
    
    return {
      name: path.basename(filePath),
      path: filePath,
      type: 'file',
      size: stats.size,
      sha: '', // Would normally compute this
      lastCommit: getLastCommitForPath(repoPath, filePath)
    };
  }
}

function getLastCommitForPath(repoPath, filePath) {
  try {
    // Use mgit log to get last commit for this file or directory
    const output = execSync(`mgit log -1 --format="%h|%an|%at|%s" -- "${filePath}"`, { 
      cwd: repoPath, 
      encoding: 'utf8' 
    });
    
    const [hash, author, timestamp, message] = output.trim().split('|');
    
    return {
      hash,
      message,
      author,
      date: new Date(parseInt(timestamp) * 1000).toISOString()
    };
  } catch (err) {
    console.error(`Error getting last commit for ${filePath}:`, err);
    
    // Return placeholder commit info
    return {
      hash: '',
      message: 'Unknown',
      author: 'Unknown',
      date: new Date().toISOString()
    };
  }
}

function getFileContent(repoPath, filePath, branch) {
  try {
    // First, ensure we're on the right branch
    execSync(`mgit checkout ${branch}`, { cwd: repoPath });
    
    // Read the file
    const fullPath = path.join(repoPath, filePath);
    return fs.readFileSync(fullPath);
  } catch (err) {
    console.error(`Error getting file content for ${filePath}:`, err);
    throw err;
  }
}

function isBinaryFile(extension) {
  // Common binary file extensions
  const binaryExtensions = [
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.pdf', '.doc', '.docx',
    '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.gz', '.tar', '.bin',
    '.exe', '.dll', '.so', '.o', '.class'
  ];
  
  return binaryExtensions.includes(extension);
}

function getCommitHistory(repoPath, branch, filePath) {
  try {
    // Create the git log command
    let command = 'mgit log --format="%h|%an|%ae|%at|%s"';
    
    if (branch) {
      command += ` ${branch}`;
    }
    
    if (filePath) {
      command += ` -- "${filePath}"`;
    }
    
    // Execute the command
    const output = execSync(command, { cwd: repoPath, encoding: 'utf8' });
    
    // Parse the output
    return output.split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => {
        const [hash, author, email, timestamp, message] = line.split('|');
        
        // Look for mgit commit mapping if available
        let mgitHash = getMGitHash(repoPath, hash);
        
        return {
          hash: hash,
          mgitHash: mgitHash || null,
          author: {
            name: author,
            email: email
          },
          date: new Date(parseInt(timestamp) * 1000).toISOString(),
          message: message
        };
      });
  } catch (err) {
    console.error('Error getting commit history:', err);
    return [];
  }
}

function getCommitDetail(repoPath, sha) {
  try {
    // Get commit details
    const commitOutput = execSync(`mgit show --no-color --format="%H|%an|%ae|%at|%cn|%ce|%ct|%P|%B" ${sha}`, {
      cwd: repoPath,
      encoding: 'utf8'
    });
    
    const lines = commitOutput.split('\n');
    const headerLine = lines[0];
    const [hash, authorName, authorEmail, authorTimestamp, committerName, committerEmail, commitTimestamp, parents, ...messageParts] = headerLine.split('|');
    
    // The rest of the output is the diff
    const diffStart = commitOutput.indexOf('diff --git');
    const diff = diffStart >= 0 ? commitOutput.substring(diffStart) : '';
    
    // Check for nostr pubkey
    const nostrPubkey = getNostrPubkey(repoPath, hash);
    
    return {
      hash: hash,
      mgitHash: getMGitHash(repoPath, hash) || null,
      author: {
        name: authorName,
        email: authorEmail,
        date: new Date(parseInt(authorTimestamp) * 1000).toISOString(),
        nostrPubkey: nostrPubkey
      },
      committer: {
        name: committerName,
        email: committerEmail,
        date: new Date(parseInt(commitTimestamp) * 1000).toISOString()
      },
      message: messageParts.join('|').trim(),
      parents: parents.split(' ').filter(p => p.length > 0),
      diff: diff
    };
  } catch (err) {
    console.error(`Error getting commit detail for ${sha}:`, err);
    return null;
  }
}

function getMGitHash(repoPath, gitHash) {
  try {
    // Try to read the nostr_mappings.json file
    const mappingsPath = path.join(repoPath, '.mgit', 'nostr_mappings.json');
    
    if (!fs.existsSync(mappingsPath)) {
      return null;
    }
    
    const mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    
    // Find the mapping for this git hash
    const mapping = mappings.find(m => m.GitHash === gitHash);
    
    return mapping ? mapping.MGitHash : null;
  } catch (err) {
    console.error(`Error getting MGit hash for ${gitHash}:`, err);
    return null;
  }
}

function getNostrPubkey(repoPath, gitHash) {
  try {
    // Try to read the nostr_mappings.json file
    const mappingsPath = path.join(repoPath, '.mgit', 'nostr_mappings.json');
    
    if (!fs.existsSync(mappingsPath)) {
      return null;
    }
    
    const mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    
    // Find the mapping for this git hash
    const mapping = mappings.find(m => m.GitHash === gitHash);
    
    return mapping ? mapping.Pubkey : null;
  } catch (err) {
    console.error(`Error getting Nostr pubkey for ${gitHash}:`, err);
    return null;
  }
}

// Express static file serving for the React frontend ONLY
// This should point to your compiled frontend files, NOT the repository directory
app.use(express.static(path.join(__dirname, 'public')));

// For any routes that should render the React app (client-side routing)
app.get('*', (req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api/')) {
    return next();
  }
  // Serve the main index.html for all non-API routes to support client-side routing
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});