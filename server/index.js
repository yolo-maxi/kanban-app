const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const { createWriteStream } = require('fs');

const app = express();
const PORT = 3400;

// ============ FILE LOCKING ============
// Prevents race conditions when multiple requests modify the same file

const fileLocks = new Map();

async function withFileLock(filePath, fn) {
  // Wait for existing lock
  while (fileLocks.get(filePath)) {
    await new Promise(r => setTimeout(r, 50));
  }
  
  // Acquire lock
  fileLocks.set(filePath, true);
  
  try {
    return await fn();
  } finally {
    // Release lock
    fileLocks.delete(filePath);
  }
}

// Data paths
const DATA_DIR = path.join(__dirname, '../data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');
const PROJECTS_PATH = path.join(DATA_DIR, 'projects.json');
const KANBAN_DIR = '/home/xiko/kanban-projects';  // Auto-created project files go here

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'https://kanban.repo.box')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // same-origin/server-to-server/curl
    if (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS origin not allowed'));
  },
  credentials: true,
}));
app.use(express.json());

// ============ DATA HELPERS ============

async function loadUsers() {
  try {
    const data = await fs.readFile(USERS_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return { users: {}, tokens: {} };
  }
}

async function saveUsers(data) {
  await fs.writeFile(USERS_PATH, JSON.stringify(data, null, 2));
}

async function loadProjects() {
  let projectsData;
  try {
    const data = await fs.readFile(PROJECTS_PATH, 'utf8');
    projectsData = JSON.parse(data);
  } catch {
    projectsData = { projects: {} };
  }

  // Auto-discover .md files in KANBAN_DIR not yet registered
  try {
    const files = await fs.readdir(KANBAN_DIR);
    let dirty = false;
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const id = file.replace(/\.md$/, '');
      if (projectsData.projects[id]) continue;
      // Auto-register with sensible defaults
      const name = id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      // Grant all admin users access by default
      const usersData = JSON.parse(await fs.readFile(USERS_PATH, 'utf8').catch(() => '{"users":{}}'));
      const perms = {};
      for (const [uid, u] of Object.entries(usersData.users || {})) {
        if (u.role === 'admin') perms[uid] = 'admin';
      }
      projectsData.projects[id] = {
        name,
        file: path.join(KANBAN_DIR, file),
        owner: Object.keys(perms)[0] || 'admin',
        permissions: perms,
        createdAt: Date.now()
      };
      dirty = true;
      console.log(`[auto-index] Registered new board: ${id} (${file})`);
    }
    if (dirty) await saveProjects(projectsData);
  } catch (err) {
    console.error('[auto-index] Failed to scan KANBAN_DIR:', err.message);
  }

  return projectsData;
}

async function saveProjects(data) {
  await fs.writeFile(PROJECTS_PATH, JSON.stringify(data, null, 2));
}

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function extractAuthToken(req) {
  const allowQuery = String(process.env.ALLOW_QUERY_TOKEN_AUTH || '').toLowerCase() === 'true';
  const headerToken = req.headers['x-auth-token'];
  const queryToken = allowQuery ? req.query.token : undefined;
  const cookieToken = req.headers.cookie?.split(';')
    .find(c => c.trim().startsWith('kanban_token='))
    ?.split('=')[1];

  return headerToken || queryToken || cookieToken;
}

// ============ AUTH MIDDLEWARE ============

async function authMiddleware(req, res, next) {
  const authToken = extractAuthToken(req);
  
  if (!authToken) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  const userData = await loadUsers();
  const userId = userData.tokens[authToken];
  
  if (!userId || !userData.users[userId]) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  req.user = { id: userId, ...userData.users[userId] };
  req.token = authToken;
  next();
}

// Check if user can access project (viewer, editor, or admin)
async function canAccessProject(userId, projectId) {
  const projectsData = await loadProjects();
  const project = projectsData.projects[projectId];
  if (!project) return false;
  
  const perm = project.permissions[userId];
  return perm === 'viewer' || perm === 'editor' || perm === 'admin';
}

// Check if user can edit project (editor or admin)
async function canEditProject(userId, projectId) {
  const projectsData = await loadProjects();
  const project = projectsData.projects[projectId];
  if (!project) return false;
  
  const perm = project.permissions[userId];
  return perm === 'editor' || perm === 'admin';
}

// Check if user is admin of project or global admin
async function isProjectAdmin(userId, projectId) {
  const userData = await loadUsers();
  if (userData.users[userId]?.role === 'admin') return true;
  
  const projectsData = await loadProjects();
  const project = projectsData.projects[projectId];
  return project?.permissions[userId] === 'admin' || project?.owner === userId;
}

// ============ KANBAN PARSING ============

function parseKanban(content) {
  const lines = content.split('\n');
  const columns = [];
  let currentColumn = null;
  let currentTask = null;
  let configSection = false;
  let config = {};
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('## ⚙️ Configuration')) {
      configSection = true;
      continue;
    }
    
    if (line.match(/^## [💡📋🔨🚧👀✅]/)) {
      configSection = false;
      if (currentTask && currentColumn) {
        currentColumn.tasks.push(currentTask);
      }
      currentTask = null;
      
      const match = line.match(/^## (.+)$/);
      if (match) {
        currentColumn = {
          id: match[1].toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'),
          title: match[1],
          tasks: []
        };
        columns.push(currentColumn);
      }
      continue;
    }
    
    if (line.match(/^### TASK-\d+/)) {
      if (currentTask && currentColumn) {
        currentColumn.tasks.push(currentTask);
      }
      
      const match = line.match(/^### (TASK-\d+) \| (.+)$/);
      if (match) {
        currentTask = {
          id: match[1],
          title: match[2],
          content: line,
          metadata: {},
          body: []
        };
      }
      continue;
    }
    
    if (currentTask && line.startsWith('**')) {
      currentTask.content += '\n' + line;
      
      const priorityMatch = line.match(/\*\*Priority\*\*:\s*([^|]+)/);
      if (priorityMatch) currentTask.metadata.priority = priorityMatch[1].trim();
      
      const projectMatch = line.match(/\*\*Project\*\*:\s*([^|]+)/);
      if (projectMatch) currentTask.metadata.project = projectMatch[1].trim();
      
      const assignedMatch = line.match(/\*\*Assigned\*\*:\s*([^|]+)/);
      if (assignedMatch) currentTask.metadata.assigned = assignedMatch[1].trim();
      
      const creatorMatch = line.match(/\*\*Creator\*\*:\s*([^|]+)/);
      if (creatorMatch) currentTask.metadata.creator = creatorMatch[1].trim();
      
      const tagsMatch = line.match(/\*\*Tags\*\*:\s*(.+)$/);
      if (tagsMatch) currentTask.metadata.tags = tagsMatch[1].trim();
      
      const closedMatch = line.match(/\*\*Closed\*\*:\s*(.+)$/);
      if (closedMatch) currentTask.metadata.closed = closedMatch[1].trim();
      
      continue; // Don't add ** lines again in the catch-all block below
    }
    
    // Extract history from HTML comment
    if (currentTask && line.includes('<!-- History:')) {
      // Start capturing history
      currentTask._inHistory = true;
      currentTask.metadata.history = [];
    } else if (currentTask && currentTask._inHistory) {
      if (line.includes('-->')) {
        currentTask._inHistory = false;
      } else if (line.trim()) {
        currentTask.metadata.history.push(line.trim());
      }
      
      continue;
    }
    
    if (currentTask && line.trim() !== '' && !line.startsWith('<!--')) {
      currentTask.content += '\n' + line;
      currentTask.body.push(line);
    } else if (currentTask && line.trim() === '') {
      currentTask.content += '\n';
    }
    
    if (configSection && line.startsWith('**')) {
      const match = line.match(/\*\*([^*]+)\*\*:\s*(.+)$/);
      if (match) {
        config[match[1].toLowerCase()] = match[2];
      }
    }
  }
  
  if (currentTask && currentColumn) {
    currentColumn.tasks.push(currentTask);
  }
  
  return { columns, config };
}

function rebuildKanban(data, originalContent) {
  const lines = originalContent.split('\n');
  let result = [];
  let skipUntilNextColumn = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.match(/^## [💡📋🔨🚧👀✅]/)) {
      if (skipUntilNextColumn) {
        skipUntilNextColumn = false;
      }
      
      result.push(line);
      result.push('');
      
      const colTitle = line.match(/^## (.+)$/)?.[1];
      const col = data.columns.find(c => c.title === colTitle);
      
      if (col) {
        const nextLine = lines[i + 1];
        if (nextLine?.startsWith('<!--')) {
          result.push(nextLine);
          result.push('');
          i++;
        }
        
        for (const task of col.tasks) {
          result.push(task.content.trim());
          result.push('');
        }
      }
      
      skipUntilNextColumn = true;
      continue;
    }
    
    if (skipUntilNextColumn) {
      continue;
    }
    
    result.push(line);
  }
  
  return result.join('\n');
}

function getNextTaskId(content) {
  const match = content.match(/<!-- Config: Last Task ID: (\d+) -->/);
  const lastId = match ? parseInt(match[1]) : 0;
  return lastId + 1;
}

function updateTaskIdInContent(content, newId) {
  return content.replace(
    /<!-- Config: Last Task ID: \d+ -->/,
    `<!-- Config: Last Task ID: ${newId.toString().padStart(3, '0')} -->`
  );
}

// Normalize task ID: accepts both TASK-XXX and PROJECTNAME-XXX formats
// Returns internal format (TASK-XXX)
function normalizeTaskId(taskIdInput, projectId = null) {
  // Already in TASK-XXX format
  if (/^TASK-\d+$/i.test(taskIdInput)) {
    return taskIdInput.toUpperCase();
  }
  
  // Extract number from PROJECTNAME-XXX format
  const match = taskIdInput.match(/^[A-Z0-9_-]+-(\d+)$/i);
  if (match) {
    return `TASK-${match[1].padStart(3, '0')}`;
  }
  
  // Return as-is if unrecognized format
  return taskIdInput;
}

// Build display ID for API responses
function buildDisplayId(taskId, projectId) {
  const num = taskId.replace(/^TASK-/i, '');
  return `${projectId.toUpperCase()}-${num}`;
}

// ============ AUTH ROUTES ============

// Magic link auth - sets cookie and redirects
app.get('/auth', async (req, res) => {
  const { token } = req.query;
  const userData = await loadUsers();
  const userId = userData.tokens[token];
  
  if (!userId || !userData.users[userId]) {
    return res.status(401).send('Invalid token');
  }
  
  // Set HttpOnly cookie (30 days)
  res.cookie('kanban_token', token, { 
    httpOnly: true, 
    secure: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    path: '/'
  });
  
  res.redirect('/');
});

// Get current user info
app.get('/api/me', authMiddleware, async (req, res) => {
  const projectsData = await loadProjects();
  
  // Get projects user can access
  const accessibleProjects = {};
  for (const [projectId, project] of Object.entries(projectsData.projects)) {
    const perm = project.permissions[req.user.id];
    if (perm) {
      accessibleProjects[projectId] = {
        name: project.name,
        permission: perm,
        isOwner: project.owner === req.user.id
      };
    }
  }
  
  res.json({
    user: req.user,
    projects: accessibleProjects
  });
});

// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('kanban_token');
  res.json({ ok: true });
});

// ============ PROJECT ROUTES ============

// List all accessible projects
app.get('/api/projects', authMiddleware, async (req, res) => {
  const projectsData = await loadProjects();
  const result = {};
  
  for (const [projectId, project] of Object.entries(projectsData.projects)) {
    if (await canAccessProject(req.user.id, projectId)) {
      result[projectId] = {
        name: project.name,
        permission: project.permissions[req.user.id],
        isOwner: project.owner === req.user.id
      };
    }
  }
  
  res.json({ projects: result });
});

// Create new project (admins only)
app.post('/api/projects', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  const { id, name, file: customFile } = req.body;
  
  if (!id || !name) {
    return res.status(400).json({ error: 'id and name required' });
  }
  
  // Sanitize ID for filename
  const safeId = id.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  
  // Auto-generate file path if not provided
  const file = customFile || path.join(KANBAN_DIR, `${safeId}.md`);
  
  const projectsData = await loadProjects();
  
  if (projectsData.projects[id]) {
    return res.status(400).json({ error: 'Project already exists' });
  }
  
  // Create empty kanban file if it doesn't exist
  try {
    await fs.access(file);
  } catch {
    // Ensure directory exists
    await fs.mkdir(path.dirname(file), { recursive: true });
    
    const template = `# ${name} Kanban

<!-- Config: Last Task ID: 000 -->

## ⚙️ Configuration
**Board Name**: ${name}
**Created**: ${new Date().toISOString().split('T')[0]}

## 💡 Ideas
<!-- Parking lot for new ideas -->

## 📋 Backlog
<!-- Ready to work on -->

## 🔨 In Progress
<!-- Currently active -->

## 🚧 Blocked
<!-- Stuck, needs help -->

## 👀 Review
<!-- Awaiting review -->

## ✅ Done
<!-- Completed - shows who closed each task -->
`;
    await fs.writeFile(file, template);
  }
  
  projectsData.projects[id] = {
    name,
    file,
    owner: req.user.id,
    permissions: {
      [req.user.id]: 'admin',
      'ocean': 'admin'  // Always give Ocean access
    }
  };
  
  await saveProjects(projectsData);
  res.json({ ok: true, project: projectsData.projects[id] });
});

// Get project permissions (project admins only)
app.get('/api/projects/:project/permissions', authMiddleware, async (req, res) => {
  const { project } = req.params;
  
  if (!await isProjectAdmin(req.user.id, project)) {
    return res.status(403).json({ error: 'Project admin only' });
  }
  
  const projectsData = await loadProjects();
  const proj = projectsData.projects[project];
  
  if (!proj) {
    return res.status(404).json({ error: 'Project not found' });
  }
  
  const userData = await loadUsers();
  
  // Build permissions with user names
  const permissions = {};
  for (const [userId, perm] of Object.entries(proj.permissions)) {
    permissions[userId] = {
      permission: perm,
      name: userData.users[userId]?.name || userId
    };
  }
  
  res.json({ permissions, owner: proj.owner });
});

// Set user permission for project
app.put('/api/projects/:project/permissions/:userId', authMiddleware, async (req, res) => {
  const { project, userId } = req.params;
  const { permission } = req.body;  // 'viewer', 'editor', 'admin', or null to remove
  
  if (!await isProjectAdmin(req.user.id, project)) {
    return res.status(403).json({ error: 'Project admin only' });
  }
  
  const projectsData = await loadProjects();
  const proj = projectsData.projects[project];
  
  if (!proj) {
    return res.status(404).json({ error: 'Project not found' });
  }
  
  // Can't change owner's permission
  if (userId === proj.owner) {
    return res.status(400).json({ error: "Can't change owner permission" });
  }
  
  if (permission) {
    proj.permissions[userId] = permission;
  } else {
    delete proj.permissions[userId];
  }
  
  await saveProjects(projectsData);
  res.json({ ok: true });
});

// ============ USER MANAGEMENT (admin only) ============

// List all users
app.get('/api/users', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  const userData = await loadUsers();
  
  // Don't expose tokens in list
  const users = {};
  for (const [id, user] of Object.entries(userData.users)) {
    users[id] = { ...user };
    // Find token for this user
    const token = Object.entries(userData.tokens).find(([t, uid]) => uid === id)?.[0];
    users[id].hasToken = !!token;
  }
  
  res.json({ users });
});

// Create new user (returns magic link)
app.post('/api/users', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  const { id, name, email, role } = req.body;
  
  if (!id || !name) {
    return res.status(400).json({ error: 'id and name required' });
  }
  
  const userData = await loadUsers();
  
  if (userData.users[id]) {
    return res.status(400).json({ error: 'User already exists' });
  }
  
  // Create user
  userData.users[id] = {
    name,
    email: email || null,
    role: role || 'user'
  };
  
  // Generate token
  const token = generateToken();
  userData.tokens[token] = id;
  
  await saveUsers(userData);
  
  const magicLink = `https://kanban.repo.box/auth?token=${token}`;
  
  res.json({ 
    ok: true, 
    user: userData.users[id],
    magicLink 
  });
});

// Regenerate token for user
app.post('/api/users/:userId/token', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  const { userId } = req.params;
  const userData = await loadUsers();
  
  if (!userData.users[userId]) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Revoke old token
  for (const [token, uid] of Object.entries(userData.tokens)) {
    if (uid === userId) {
      delete userData.tokens[token];
    }
  }
  
  // Generate new token
  const token = generateToken();
  userData.tokens[token] = userId;
  
  await saveUsers(userData);
  
  const magicLink = `https://kanban.repo.box/auth?token=${token}`;
  
  res.json({ ok: true, magicLink });
});

// Delete user
app.delete('/api/users/:userId', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  
  const { userId } = req.params;
  const userData = await loadUsers();
  
  if (!userData.users[userId]) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Can't delete yourself
  if (userId === req.user.id) {
    return res.status(400).json({ error: "Can't delete yourself" });
  }
  
  // Remove tokens
  for (const [token, uid] of Object.entries(userData.tokens)) {
    if (uid === userId) {
      delete userData.tokens[token];
    }
  }
  
  // Remove user
  delete userData.users[userId];
  
  // Remove from all project permissions
  const projectsData = await loadProjects();
  for (const project of Object.values(projectsData.projects)) {
    delete project.permissions[userId];
  }
  await saveProjects(projectsData);
  
  await saveUsers(userData);
  res.json({ ok: true });
});

// ============ KANBAN API (project-scoped) ============

// Get kanban data for a project
app.get('/api/projects/:project/kanban', authMiddleware, async (req, res) => {
  const { project } = req.params;
  
  if (!await canAccessProject(req.user.id, project)) {
    return res.status(403).json({ error: 'No access to this project' });
  }
  
  const projectsData = await loadProjects();
  const proj = projectsData.projects[project];
  
  try {
    const content = await fs.readFile(proj.file, 'utf8');
    const data = parseKanban(content);
    data.projectName = proj.name;
    data.permission = proj.permissions[req.user.id];
    
    // Add displayId to each task for API consumers
    for (const col of data.columns) {
      for (const task of col.tasks) {
        task.displayId = buildDisplayId(task.id, project);
      }
    }
    
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get raw markdown
app.get('/api/projects/:project/kanban/raw', authMiddleware, async (req, res) => {
  const { project } = req.params;
  
  if (!await canAccessProject(req.user.id, project)) {
    return res.status(403).json({ error: 'No access to this project' });
  }
  
  const projectsData = await loadProjects();
  const proj = projectsData.projects[project];
  
  try {
    const content = await fs.readFile(proj.file, 'utf8');
    res.type('text/markdown').send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save kanban
app.put('/api/projects/:project/kanban', authMiddleware, async (req, res) => {
  const { project } = req.params;
  
  if (!await canEditProject(req.user.id, project)) {
    return res.status(403).json({ error: 'No edit access to this project' });
  }
  
  const projectsData = await loadProjects();
  const proj = projectsData.projects[project];
  
  try {
    const original = await fs.readFile(proj.file, 'utf8');
    const newContent = rebuildKanban(req.body, original);
    await fs.writeFile(proj.file, newContent);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move task
app.post('/api/projects/:project/kanban/move', authMiddleware, async (req, res) => {
  const { project } = req.params;
  
  if (!await canEditProject(req.user.id, project)) {
    return res.status(403).json({ error: 'No edit access to this project' });
  }
  
  const projectsData = await loadProjects();
  const proj = projectsData.projects[project];
  
  // Use file lock to prevent race conditions
  return withFileLock(proj.file, async () => {
    try {
      const { fromColumn, toColumn, position } = req.body;
      const taskId = normalizeTaskId(req.body.taskId, project);
      const content = await fs.readFile(proj.file, 'utf8');
    const data = parseKanban(content);
    
    const srcCol = data.columns.find(c => c.title === fromColumn);
    const taskIndex = srcCol?.tasks.findIndex(t => t.id === taskId);
    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const [task] = srcCol.tasks.splice(taskIndex, 1);
    
    const destCol = data.columns.find(c => c.title === toColumn);
    if (!destCol) {
      return res.status(404).json({ error: 'Destination column not found' });
    }
    
    // Add audit trail entry
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const auditEntry = `${now} | ${req.user.name} moved from "${fromColumn}" to "${toColumn}"`;
    
    // Find or create history block
    const historyMatch = task.content.match(/<!-- History:\n([\s\S]*?)-->/);
    if (historyMatch) {
      const existingHistory = historyMatch[1];
      task.content = task.content.replace(
        /<!-- History:\n[\s\S]*?-->/,
        `<!-- History:\n${existingHistory}${auditEntry}\n-->`
      );
    } else {
      task.content = task.content.trim() + `\n\n<!-- History:\n${auditEntry}\n-->`;
    }
    
    // Add "Closed by" when moving to Done column
    if (toColumn.includes('Done') && !fromColumn.includes('Done')) {
      const today = new Date().toISOString().split('T')[0];
      const closedByLine = `**Closed**: ${today} by ${req.user.name}`;
      if (!task.content.includes('**Closed**:')) {
        const lines = task.content.split('\n');
        let insertIdx = 0;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('**')) insertIdx = i + 1;
        }
        lines.splice(insertIdx, 0, closedByLine);
        task.content = lines.join('\n');
      }
    }
    
    destCol.tasks.splice(position ?? destCol.tasks.length, 0, task);
    
    const newContent = rebuildKanban(data, content);
    await fs.writeFile(proj.file, newContent);
    
    res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

// Create task
app.post('/api/projects/:project/tasks', authMiddleware, async (req, res) => {
  const { project } = req.params;
  
  if (!await canEditProject(req.user.id, project)) {
    return res.status(403).json({ error: 'No edit access to this project' });
  }
  
  const projectsData = await loadProjects();
  const proj = projectsData.projects[project];
  
  try {
    const { column, title, priority, assigned, creator, tags, description } = req.body;
    let content = await fs.readFile(proj.file, 'utf8');
    
    const taskId = getNextTaskId(content);
    const taskIdStr = `TASK-${taskId.toString().padStart(3, '0')}`;
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
    
    let taskMd = `### ${taskIdStr} | ${title}\n\n`;
    taskMd += `**Priority**: ${priority || 'P2'}`;
    taskMd += ` | **Project**: ${project}`;
    if (assigned) taskMd += ` | **Assigned**: ${assigned}`;
    if (creator) taskMd += ` | **Creator**: ${creator}`;
    taskMd += `\n**Created**: ${today}`;
    if (tags) taskMd += `\n**Tags**: ${tags}`;
    taskMd += '\n';
    if (description) taskMd += `\n${description}\n`;
    taskMd += `\n<!-- History:\n${now} | ${req.user.name} created in "${column}"\n-->\n`;
    
    const columnHeader = `## ${column}`;
    const lines = content.split('\n');
    let insertIndex = -1;
    
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(columnHeader)) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].startsWith('## ') || lines[j].startsWith('### TASK-')) {
            insertIndex = j;
            break;
          }
        }
        if (insertIndex === -1) insertIndex = lines.length;
        break;
      }
    }
    
    if (insertIndex === -1) {
      return res.status(404).json({ error: 'Column not found' });
    }
    
    lines.splice(insertIndex, 0, taskMd);
    content = lines.join('\n');
    content = updateTaskIdInContent(content, taskId);
    
    await fs.writeFile(proj.file, content);
    res.json({ 
      ok: true, 
      taskId: taskIdStr,
      displayId: buildDisplayId(taskIdStr, project),
      _note: 'Both taskId (TASK-XXX) and displayId (PROJECT-XXX) reference the same task'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update task
app.put('/api/projects/:project/tasks/:id', authMiddleware, async (req, res) => {
  const { project } = req.params;
  const taskId = normalizeTaskId(req.params.id, project);
  
  if (!await canEditProject(req.user.id, project)) {
    return res.status(403).json({ error: 'No edit access to this project' });
  }
  
  const projectsData = await loadProjects();
  const proj = projectsData.projects[project];
  
  try {
    const { title, priority, assigned, creator, tags, description } = req.body;
    let content = await fs.readFile(proj.file, 'utf8');
    
    const taskRegex = new RegExp(`### ${taskId} \\| .+?(?=### TASK-|## |$)`, 's');
    const match = content.match(taskRegex);
    
    if (!match) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const createdMatch = match[0].match(/\*\*Created\*\*:\s*(\d{4}-\d{2}-\d{2})/);
    const startedMatch = match[0].match(/\*\*Started\*\*:\s*(\d{4}-\d{2}-\d{2})/);
    
    let taskMd = `### ${taskId} | ${title}\n\n`;
    taskMd += `**Priority**: ${priority || 'P2'}`;
    taskMd += ` | **Project**: ${project}`;
    if (assigned) taskMd += ` | **Assigned**: ${assigned}`;
    if (creator) taskMd += ` | **Creator**: ${creator}`;
    taskMd += `\n**Created**: ${createdMatch ? createdMatch[1] : new Date().toISOString().split('T')[0]}`;
    if (startedMatch) taskMd += ` | **Started**: ${startedMatch[1]}`;
    if (tags) taskMd += `\n**Tags**: ${tags}`;
    taskMd += '\n';
    if (description) taskMd += `\n${description}\n`;
    taskMd += '\n';
    
    content = content.replace(taskRegex, taskMd);
    await fs.writeFile(proj.file, content);
    res.json({ ok: true, taskId, displayId: buildDisplayId(taskId, project) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete task
app.delete('/api/projects/:project/tasks/:id', authMiddleware, async (req, res) => {
  const { project } = req.params;
  const taskId = normalizeTaskId(req.params.id, project);
  
  if (!await canEditProject(req.user.id, project)) {
    return res.status(403).json({ error: 'No edit access to this project' });
  }
  
  const projectsData = await loadProjects();
  const proj = projectsData.projects[project];
  
  try {
    let content = await fs.readFile(proj.file, 'utf8');
    const taskRegex = new RegExp(`### ${taskId} \\| .+?(?=### TASK-|## |$)`, 's');
    
    if (!taskRegex.test(content)) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    content = content.replace(taskRegex, '');
    content = content.replace(/\n{3,}/g, '\n\n');
    
    await fs.writeFile(proj.file, content);
    res.json({ ok: true, taskId, displayId: buildDisplayId(taskId, project) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PROJECT BRIEFS ============

const BRIEFS_DIR = '/home/xiko/clawd/memory/projects';

// Get project brief
app.get('/api/projects/:project/brief', authMiddleware, async (req, res) => {
  const { project } = req.params;
  
  if (!await canAccessProject(req.user.id, project)) {
    return res.status(403).json({ error: 'No access to this project' });
  }
  
  const briefPath = path.join(BRIEFS_DIR, `${project}.md`);
  
  try {
    const content = await fs.readFile(briefPath, 'utf8');
    res.json({ content, exists: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Return template if no brief exists
      try {
        const template = await fs.readFile(path.join(BRIEFS_DIR, '_TEMPLATE.md'), 'utf8');
        const prefilled = template.replace('[NAME]', project.charAt(0).toUpperCase() + project.slice(1));
        res.json({ content: prefilled, exists: false });
      } catch {
        res.json({ content: `# Project: ${project}\n\n> Description\n\n## Status\n- **Phase**: building\n- **Last touched**: ${new Date().toISOString().split('T')[0]}\n\n## Resources\n\n## History\n`, exists: false });
      }
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// Update project brief
app.put('/api/projects/:project/brief', authMiddleware, async (req, res) => {
  const { project } = req.params;
  const { content } = req.body;
  
  if (!await canEditProject(req.user.id, project)) {
    return res.status(403).json({ error: 'No edit access to this project' });
  }
  
  const briefPath = path.join(BRIEFS_DIR, `${project}.md`);
  
  try {
    await fs.writeFile(briefPath, content);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ LEGACY ROUTES (backward compatibility) ============

// These use the old single-file approach for backward compatibility
const LEGACY_KANBAN = process.env.KANBAN_PATH || '/home/xiko/clawd/kanban.md';
const LEGACY_TOKEN = process.env.KANBAN_TOKEN;

// Legacy auth check (for old tokens)
function legacyAuthMiddleware(req, res, next) {
  const token = extractAuthToken(req);

  if (LEGACY_TOKEN && token === LEGACY_TOKEN) {
    req.user = { id: 'fran', name: 'Fran (legacy)', role: 'admin' };
    return next();
  }
  
  // Try new auth
  authMiddleware(req, res, next);
}

app.get('/api/kanban', legacyAuthMiddleware, async (req, res) => {
  try {
    const content = await fs.readFile(LEGACY_KANBAN, 'utf8');
    const data = parseKanban(content);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/kanban/raw', legacyAuthMiddleware, async (req, res) => {
  try {
    const content = await fs.readFile(LEGACY_KANBAN, 'utf8');
    res.type('text/markdown').send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/kanban', legacyAuthMiddleware, async (req, res) => {
  try {
    const original = await fs.readFile(LEGACY_KANBAN, 'utf8');
    const newContent = rebuildKanban(req.body, original);
    await fs.writeFile(LEGACY_KANBAN, newContent);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/kanban/move', legacyAuthMiddleware, async (req, res) => {
  try {
    const { taskId, fromColumn, toColumn, position } = req.body;
    const content = await fs.readFile(LEGACY_KANBAN, 'utf8');
    const data = parseKanban(content);
    
    const srcCol = data.columns.find(c => c.title === fromColumn);
    const taskIndex = srcCol?.tasks.findIndex(t => t.id === taskId);
    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const [task] = srcCol.tasks.splice(taskIndex, 1);
    
    const destCol = data.columns.find(c => c.title === toColumn);
    if (!destCol) {
      return res.status(404).json({ error: 'Destination column not found' });
    }
    
    destCol.tasks.splice(position ?? destCol.tasks.length, 0, task);
    
    const newContent = rebuildKanban(data, content);
    await fs.writeFile(LEGACY_KANBAN, newContent);
    
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', legacyAuthMiddleware, async (req, res) => {
  try {
    const { column, title, priority, project, assigned, creator, tags, description } = req.body;
    let content = await fs.readFile(LEGACY_KANBAN, 'utf8');
    
    const taskId = getNextTaskId(content);
    const taskIdStr = `TASK-${taskId.toString().padStart(3, '0')}`;
    const today = new Date().toISOString().split('T')[0];
    
    let taskMd = `### ${taskIdStr} | ${title}\n\n`;
    taskMd += `**Priority**: ${priority || 'P2'}`;
    if (project) taskMd += ` | **Project**: ${project}`;
    if (assigned) taskMd += ` | **Assigned**: ${assigned}`;
    if (creator) taskMd += ` | **Creator**: ${creator}`;
    taskMd += `\n**Created**: ${today}`;
    if (tags) taskMd += `\n**Tags**: ${tags}`;
    taskMd += '\n';
    if (description) taskMd += `\n${description}\n`;
    
    const columnHeader = `## ${column}`;
    const lines = content.split('\n');
    let insertIndex = -1;
    
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(columnHeader)) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].startsWith('## ') || lines[j].startsWith('### TASK-')) {
            insertIndex = j;
            break;
          }
        }
        if (insertIndex === -1) insertIndex = lines.length;
        break;
      }
    }
    
    if (insertIndex === -1) {
      return res.status(404).json({ error: 'Column not found' });
    }
    
    lines.splice(insertIndex, 0, taskMd);
    content = lines.join('\n');
    content = updateTaskIdInContent(content, taskId);
    
    await fs.writeFile(LEGACY_KANBAN, content);
    res.json({ ok: true, taskId: taskIdStr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ REVIEW MODE API ============

const CHATS_DIR = path.join(__dirname, 'data/chats');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure dirs exist
fsSync.mkdirSync(CHATS_DIR, { recursive: true });
fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });

// Serve uploaded images
app.use('/uploads', express.static(UPLOADS_DIR));

// GET /api/reviews — all tasks in Review column across all projects
app.get('/api/reviews', authMiddleware, async (req, res) => {
  try {
    const projectsData = await loadProjects();
    const reviews = [];
    
    for (const [projectId, project] of Object.entries(projectsData.projects)) {
      if (!await canAccessProject(req.user.id, projectId)) continue;
      
      try {
        const content = await fs.readFile(project.file, 'utf8');
        const data = parseKanban(content);
        
        const reviewCol = data.columns.find(c => c.title.includes('Review'));
        if (!reviewCol) continue;
        
        for (const task of reviewCol.tasks) {
          // Extract images from HTML comment
          const imgMatch = task.content.match(/<!-- images: (.+?) -->/);
          const images = imgMatch ? imgMatch[1].split(',').map(s => s.trim()) : [];
          
          // Extract confidence
          const confMatch = task.content.match(/\*\*Confidence\*\*:\s*(\w+)/);
          
          reviews.push({
            ...task,
            displayId: buildDisplayId(task.id, projectId),
            _project: projectId,
            _projectName: project.name,
            images,
            confidence: confMatch ? confMatch[1] : null,
          });
        }
      } catch (err) {
        console.error(`Failed to read ${projectId}:`, err.message);
      }
    }
    
    res.json({ reviews });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reviews/:taskId/approve — move to Done
app.post('/api/reviews/:taskId/approve', authMiddleware, async (req, res) => {
  try {
    const { project } = req.body;
    if (!project) return res.status(400).json({ error: 'project required' });
    if (!await canEditProject(req.user.id, project)) {
      return res.status(403).json({ error: 'No edit access' });
    }
    
    const projectsData = await loadProjects();
    const proj = projectsData.projects[project];
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    
    const taskId = normalizeTaskId(req.params.taskId, project);
    
    return withFileLock(proj.file, async () => {
      const content = await fs.readFile(proj.file, 'utf8');
      const data = parseKanban(content);
      
      const reviewCol = data.columns.find(c => c.title.includes('Review'));
      if (!reviewCol) return res.status(404).json({ error: 'Review column not found' });
      
      const taskIndex = reviewCol.tasks.findIndex(t => t.id === taskId);
      if (taskIndex === -1) return res.status(404).json({ error: 'Task not found in Review' });
      
      const [task] = reviewCol.tasks.splice(taskIndex, 1);
      
      const doneCol = data.columns.find(c => c.title.includes('Done'));
      if (!doneCol) return res.status(404).json({ error: 'Done column not found' });
      
      // Add audit trail
      const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const auditEntry = `${now} | ${req.user.name} approved (moved to Done)`;
      const historyMatch = task.content.match(/<!-- History:\n([\s\S]*?)-->/);
      if (historyMatch) {
        task.content = task.content.replace(
          /<!-- History:\n[\s\S]*?-->/,
          `<!-- History:\n${historyMatch[1]}${auditEntry}\n-->`
        );
      } else {
        task.content = task.content.trim() + `\n\n<!-- History:\n${auditEntry}\n-->`;
      }
      
      // Add closed by
      const today = new Date().toISOString().split('T')[0];
      if (!task.content.includes('**Closed**:')) {
        const lines = task.content.split('\n');
        let insertIdx = 0;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('**')) insertIdx = i + 1;
        }
        lines.splice(insertIdx, 0, `**Closed**: ${today} by ${req.user.name}`);
        task.content = lines.join('\n');
      }
      
      doneCol.tasks.unshift(task);
      
      const newContent = rebuildKanban(data, content);
      await fs.writeFile(proj.file, newContent);
      res.json({ ok: true });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reviews/:taskId/reject — move back to In Progress
app.post('/api/reviews/:taskId/reject', authMiddleware, async (req, res) => {
  try {
    const { project } = req.body;
    if (!project) return res.status(400).json({ error: 'project required' });
    if (!await canEditProject(req.user.id, project)) {
      return res.status(403).json({ error: 'No edit access' });
    }
    
    const projectsData = await loadProjects();
    const proj = projectsData.projects[project];
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    
    const taskId = normalizeTaskId(req.params.taskId, project);
    
    return withFileLock(proj.file, async () => {
      const content = await fs.readFile(proj.file, 'utf8');
      const data = parseKanban(content);
      
      const reviewCol = data.columns.find(c => c.title.includes('Review'));
      if (!reviewCol) return res.status(404).json({ error: 'Review column not found' });
      
      const taskIndex = reviewCol.tasks.findIndex(t => t.id === taskId);
      if (taskIndex === -1) return res.status(404).json({ error: 'Task not found in Review' });
      
      const [task] = reviewCol.tasks.splice(taskIndex, 1);
      
      const ipCol = data.columns.find(c => c.title.includes('In Progress'));
      if (!ipCol) return res.status(404).json({ error: 'In Progress column not found' });
      
      const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
      const feedback = req.body.feedback || '';
      const auditEntry = `${now} | ${req.user.name} rejected${feedback ? ': ' + feedback : ''}`;
      const historyMatch = task.content.match(/<!-- History:\n([\s\S]*?)-->/);
      if (historyMatch) {
        task.content = task.content.replace(
          /<!-- History:\n[\s\S]*?-->/,
          `<!-- History:\n${historyMatch[1]}${auditEntry}\n-->`
        );
      } else {
        task.content = task.content.trim() + `\n\n<!-- History:\n${auditEntry}\n-->`;
      }
      
      ipCol.tasks.unshift(task);
      
      const newContent = rebuildKanban(data, content);
      await fs.writeFile(proj.file, newContent);
      res.json({ ok: true });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reviews/:taskId/chat — AI chat about a task
app.post('/api/reviews/:taskId/chat', authMiddleware, async (req, res) => {
  try {
    const { project, message } = req.body;
    if (!project || !message) return res.status(400).json({ error: 'project and message required' });
    
    const taskId = normalizeTaskId(req.params.taskId, project);
    const chatFile = path.join(CHATS_DIR, `${project}-${taskId}.json`);
    
    // Load chat history
    let history = [];
    try {
      const data = await fs.readFile(chatFile, 'utf8');
      history = JSON.parse(data);
    } catch {}
    
    // Get task details
    const projectsData = await loadProjects();
    const proj = projectsData.projects[project];
    if (!proj) return res.status(404).json({ error: 'Project not found' });
    
    const content = await fs.readFile(proj.file, 'utf8');
    const kanbanData = parseKanban(content);
    let taskContent = '';
    for (const col of kanbanData.columns) {
      const task = col.tasks.find(t => t.id === taskId);
      if (task) { taskContent = task.content; break; }
    }
    
    // Load project brief
    let briefContent = '';
    try {
      briefContent = await fs.readFile(path.join(BRIEFS_DIR, `${project}.md`), 'utf8');
    } catch {}
    
    // Add user message to history
    history.push({ role: 'user', content: message, timestamp: new Date().toISOString() });
    
    // Build messages for Anthropic
    const systemPrompt = `You are a helpful assistant reviewing a task on a kanban board. Here's the context:

## Task Details
${taskContent}

## Project Brief
${briefContent || 'No brief available.'}

Answer questions about this task concisely. Help with review decisions, suggest improvements, or discuss implementation details.`;
    
    const apiMessages = history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role, content: m.content }));
    
    // Call OpenRouter API (OpenAI-compatible)
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      const reply = 'Chat AI not configured. Set OPENROUTER_API_KEY in server/.env';
      history.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
      await fs.writeFile(chatFile, JSON.stringify(history, null, 2));
      return res.json({ reply, history });
    }
    
    const apiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          ...apiMessages,
        ],
      }),
    });
    
    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('OpenRouter API error:', errText);
      return res.status(502).json({ error: 'AI service error' });
    }
    
    const aiData = await apiRes.json();
    const reply = aiData.choices?.[0]?.message?.content || 'No response';
    
    history.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
    await fs.writeFile(chatFile, JSON.stringify(history, null, 2));
    
    res.json({ reply, history });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reviews/:taskId/chat — get chat history
app.get('/api/reviews/:taskId/chat', authMiddleware, async (req, res) => {
  const project = req.query.project;
  if (!project) return res.status(400).json({ error: 'project query param required' });
  const taskId = normalizeTaskId(req.params.taskId, project);
  const chatFile = path.join(CHATS_DIR, `${project}-${taskId}.json`);
  
  try {
    const data = await fs.readFile(chatFile, 'utf8');
    res.json({ history: JSON.parse(data) });
  } catch {
    res.json({ history: [] });
  }
});

// POST /api/reviews/:taskId/images — upload image to task
app.post('/api/reviews/:taskId/images', authMiddleware, async (req, res) => {
  try {
    const { project } = req.body || {};
    
    // Handle multipart - we need to parse it manually since we don't have multer
    // Actually let's add basic file handling
    const contentType = req.headers['content-type'] || '';
    
    if (!contentType.includes('multipart')) {
      return res.status(400).json({ error: 'multipart/form-data required' });
    }
    
    // We'll handle this with a simpler approach - base64 upload
    return res.status(501).json({ error: 'Use /api/upload endpoint instead' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simple base64 image upload endpoint
app.post('/api/upload', authMiddleware, express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { data, filename, project, taskId } = req.body;
    if (!data || !filename) return res.status(400).json({ error: 'data and filename required' });
    
    const ext = path.extname(filename) || '.png';
    const safeName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const filePath = path.join(UPLOADS_DIR, safeName);
    
    // Decode base64
    const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
    await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'));
    
    // If taskId and project provided, add image reference to task
    if (taskId && project) {
      const normalizedId = normalizeTaskId(taskId, project);
      const projectsData = await loadProjects();
      const proj = projectsData.projects[project];
      if (proj) {
        await withFileLock(proj.file, async () => {
          let content = await fs.readFile(proj.file, 'utf8');
          const imgComment = `<!-- images: /uploads/${safeName} -->`;
          
          // Find task and add/update images comment
          const taskRegex = new RegExp(`(### ${normalizedId} \\| [^\\n]+)`);
          const existingImgRegex = new RegExp(`(### ${normalizedId} \\| [\\s\\S]*?)<!-- images: ([^>]+) -->`);
          const existingMatch = content.match(existingImgRegex);
          
          if (existingMatch) {
            const existingImages = existingMatch[2];
            content = content.replace(
              `<!-- images: ${existingImages} -->`,
              `<!-- images: ${existingImages}, /uploads/${safeName} -->`
            );
          } else {
            // Add after task header line
            content = content.replace(taskRegex, `$1\n<!-- images: /uploads/${safeName} -->`);
          }
          
          await fs.writeFile(proj.file, content);
        });
      }
    }
    
    res.json({ ok: true, url: `/uploads/${safeName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ STATIC FILES ============

// Serve llms.txt for AI/agent documentation
app.get('/llms.txt', (req, res) => {
  res.sendFile(path.join(__dirname, '../llms.txt'));
});

// Also serve at .well-known for discoverability
app.get('/.well-known/llms.txt', (req, res) => {
  res.sendFile(path.join(__dirname, '../llms.txt'));
});

app.use(express.static(path.join(__dirname, '../client/dist')));

// SPA fallback - serve index.html for all non-API routes
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`Kanban API running on port ${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
});
