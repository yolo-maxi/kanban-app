const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

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

app.use(cors());
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
  try {
    const data = await fs.readFile(PROJECTS_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return { projects: {} };
  }
}

async function saveProjects(data) {
  await fs.writeFile(PROJECTS_PATH, JSON.stringify(data, null, 2));
}

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// ============ AUTH MIDDLEWARE ============

async function authMiddleware(req, res, next) {
  // Get token from header, query, or cookie
  const token = req.headers['x-auth-token'] || req.query.token;
  const cookieToken = req.headers.cookie?.split(';')
    .find(c => c.trim().startsWith('kanban_token='))
    ?.split('=')[1];
  
  const authToken = token || cookieToken;
  
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
const LEGACY_TOKEN = process.env.KANBAN_TOKEN || 'kanban-dev-token';

// Legacy auth check (for old tokens)
function legacyAuthMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  const cookieToken = req.headers.cookie?.split(';')
    .find(c => c.trim().startsWith('kanban_token='))
    ?.split('=')[1];
  
  if (token === LEGACY_TOKEN || cookieToken === LEGACY_TOKEN) {
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
