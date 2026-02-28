import { useState, useEffect } from 'react';
import { DndContext, closestCenter, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import Column from './components/Column';
import TaskCard from './components/TaskCard';
import TaskModal from './components/TaskModal';
import PermissionsModal from './components/PermissionsModal';
import BriefPanel from './components/BriefPanel';
import './App.css';

const API_BASE = '';

function App() {
  const [user, setUser] = useState(null);
  const [projects, setProjects] = useState({});
  const [activeProjects, setActiveProjects] = useState([]);
  const [columns, setColumns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTask, setActiveTask] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [creatingInColumn, setCreatingInColumn] = useState(null);
  const [showPermissions, setShowPermissions] = useState(false);
  const [showBrief, setShowBrief] = useState(true); // Brief panel visible by default
  const [projectCounts, setProjectCounts] = useState({});
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  // Handle resize
  useEffect(() => {
    function handleResize() {
      setIsMobile(window.innerWidth <= 768);
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: { distance: 8 },
  });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: { delay: 250, tolerance: 8 },
  });
  const sensors = useSensors(mouseSensor, touchSensor);

  useEffect(() => {
    fetchUserAndProjects();
  }, []);

  useEffect(() => {
    if (activeProjects.length > 0) {
      fetchAllKanbans();
    } else {
      setColumns([]);
    }
  }, [activeProjects]);

  useEffect(() => {
    if (Object.keys(projects).length > 0) {
      fetchProjectCounts();
    }
  }, [projects]);

  useEffect(() => {
    if (activeProjects.length === 0) return;
    const interval = setInterval(fetchAllKanbans, 20000);
    return () => clearInterval(interval);
  }, [activeProjects]);

  async function fetchUserAndProjects() {
    try {
      const res = await fetch(`${API_BASE}/api/me`, { credentials: 'include' });
      
      if (res.status === 401) {
        setError('Unauthorized. Please use a magic link to access.');
        setLoading(false);
        return;
      }
      
      const data = await res.json();
      setUser(data.user);
      setProjects(data.projects);
      
      const projectIds = Object.keys(data.projects);
      const mobile = window.innerWidth <= 768;
      
      // Check URL param first, then localStorage
      const urlParams = new URLSearchParams(window.location.search);
      const boardParam = urlParams.get('board');
      let selected = null;
      
      if (boardParam && projectIds.includes(boardParam)) {
        selected = boardParam;
      } else {
        const savedActive = localStorage.getItem('activeProjects');
        if (savedActive) {
          const parsed = JSON.parse(savedActive);
          const validActive = parsed.filter(p => projectIds.includes(p));
          if (validActive.length > 0) selected = validActive[0];
        }
      }
      
      if (!selected) selected = projectIds[0];
      
      // Update URL to reflect selection
      const newUrl = new URL(window.location);
      newUrl.searchParams.set('board', selected);
      history.replaceState(null, '', newUrl);
      
      setActiveProjects([selected]);
      localStorage.setItem('activeProjects', JSON.stringify([selected]));
      
      // Hide brief panel by default on mobile
      if (mobile) {
        setShowBrief(false);
      }
      
      setLoading(false);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  async function fetchProjectCounts() {
    const counts = {};
    for (const projectId of Object.keys(projects)) {
      try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/kanban`, {
          credentials: 'include'
        });
        if (res.ok) {
          const data = await res.json();
          let count = 0;
          for (const col of data.columns) {
            if (!col.title.includes('Done') && !col.title.includes('✅')) {
              count += col.tasks.length;
            }
          }
          counts[projectId] = count;
        }
      } catch (err) {
        console.error(`Failed to fetch count for ${projectId}:`, err);
      }
    }
    setProjectCounts(counts);
  }

  async function fetchAllKanbans() {
    const columnMap = {};
    const allColumns = [];
    
    for (const projectId of activeProjects) {
      try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/kanban`, {
          credentials: 'include'
        });
        if (res.ok) {
          const data = await res.json();
          
          for (const col of data.columns) {
            const taggedTasks = col.tasks.map(t => ({ 
              ...t, 
              _project: projectId,
              _projectName: projects[projectId]?.name || projectId
            }));
            
            if (columnMap[col.title]) {
              columnMap[col.title].tasks.push(...taggedTasks);
            } else {
              columnMap[col.title] = { ...col, tasks: taggedTasks };
              allColumns.push(col.title);
            }
          }
        }
      } catch (err) {
        console.error(`Failed to fetch ${projectId}:`, err);
      }
    }
    
    setColumns(allColumns.map(title => columnMap[title]));
  }

  function selectProject(projectId) {
    // Single select - only one project at a time
    setActiveProjects([projectId]);
    localStorage.setItem('activeProjects', JSON.stringify([projectId]));
    // Update URL param
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('board', projectId);
    history.replaceState(null, '', newUrl);
  }

  function handleDragStart(event) {
    setActiveTask(findTask(event.active.id));
  }

  function handleDragCancel() {
    setActiveTask(null);
  }

  function findTask(taskId) {
    for (const col of columns) {
      const task = col.tasks.find(t => t.id === taskId);
      if (task) return task;
    }
    return null;
  }

  function findColumn(taskId) {
    for (const col of columns) {
      if (col.tasks.find(t => t.id === taskId)) return col;
    }
    return null;
  }

  async function handleDragEnd(event) {
    const { active, over } = event;
    setActiveTask(null);
    
    if (!over) return;

    const task = findTask(active.id);
    const fromColumn = findColumn(active.id);
    
    let toColumn = columns.find(c => c.id === over.id);
    if (!toColumn) toColumn = findColumn(over.id);
    
    if (!fromColumn || !toColumn) return;
    if (fromColumn.title === toColumn.title && active.id === over.id) return;

    const newColumns = columns.map(col => ({ ...col, tasks: [...col.tasks] }));
    const srcCol = newColumns.find(c => c.title === fromColumn.title);
    const destCol = newColumns.find(c => c.title === toColumn.title);
    
    const taskIndex = srcCol.tasks.findIndex(t => t.id === active.id);
    const [movedTask] = srcCol.tasks.splice(taskIndex, 1);
    
    let destIndex = destCol.tasks.length;
    if (over.id !== toColumn.id) {
      destIndex = destCol.tasks.findIndex(t => t.id === over.id);
      if (destIndex === -1) destIndex = destCol.tasks.length;
    }
    
    destCol.tasks.splice(destIndex, 0, movedTask);
    setColumns(newColumns);

    try {
      await fetch(`${API_BASE}/api/projects/${task._project}/kanban/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          taskId: active.id,
          fromColumn: fromColumn.title,
          toColumn: toColumn.title,
          position: destIndex
        })
      });
    } catch (err) {
      console.error('Failed to save:', err);
      fetchAllKanbans();
    }
  }

  async function handleCreateTask(columnTitle, taskData) {
    const projectId = activeProjects[0];
    if (!projectId) return;

    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ column: columnTitle, ...taskData })
      });
      if (res.ok) {
        fetchAllKanbans();
        setCreatingInColumn(null);
      }
    } catch (err) {
      console.error('Failed to create:', err);
    }
  }

  async function handleUpdateTask(taskId, taskData, projectId) {
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(taskData)
      });
      if (res.ok) {
        fetchAllKanbans();
        setEditingTask(null);
      }
    } catch (err) {
      console.error('Failed to update:', err);
    }
  }

  async function handleDeleteTask(taskId, projectId) {
    if (!confirm('Delete this task?')) return;
    try {
      const res = await fetch(`${API_BASE}/api/projects/${projectId}/tasks/${taskId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.ok) {
        fetchAllKanbans();
        setEditingTask(null);
      }
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  }

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error">{error}</div>;

  const isAdmin = user?.role === 'admin';
  const projectList = Object.entries(projects);

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <div className="logo">📋 <span>{activeProjects.length > 0 && projects[activeProjects[0]] ? projects[activeProjects[0]].name : 'Kanban'}</span></div>
          
          {/* Brief toggle */}
          <button 
            className={`brief-toggle ${showBrief ? 'active' : ''}`}
            onClick={() => setShowBrief(!showBrief)}
            title={showBrief ? 'Hide brief' : 'Show brief'}
          >
            📄
          </button>
          
          {/* Project selector - desktop (single select) */}
          {projectList.length > 0 && (
            <div className="project-toggles">
              {projectList.map(([id, proj]) => (
                <button
                  key={id}
                  className={`project-chip ${activeProjects.includes(id) ? 'active' : ''}`}
                  onClick={() => selectProject(id)}
                  title={`${proj.permission} access`}
                >
                  {proj.name}
                  {projectCounts[id] > 0 && (
                    <span className="task-count">{projectCounts[id]}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          
          {/* Project dropdown - mobile */}
          {projectList.length > 0 && (
            <div className="project-dropdown-mobile">
              <select 
                value={activeProjects[0] || ''} 
                onChange={(e) => {
                  selectProject(e.target.value);
                }}
              >
                {projectList.map(([id, proj]) => (
                  <option key={id} value={id}>{proj.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        
        <div className="header-right">
          {isAdmin && (
            <button onClick={() => setShowPermissions(true)} className="settings-btn">
              ⚙️
            </button>
          )}
        </div>
      </header>
      
      {/* Mobile drawer overlay */}
      <div 
        className={`drawer-overlay ${showBrief && isMobile ? 'open' : ''}`}
        onClick={() => setShowBrief(false)}
      />
      
      <div className="main-content">
        {/* Brief Panel - Desktop: inline left side, Mobile: slide-out drawer */}
        {(showBrief || isMobile) && (
          <BriefPanel 
            projects={projects}
            activeProjects={activeProjects}
            user={user}
            isOpen={showBrief}
            isMobile={isMobile}
            onClose={() => setShowBrief(false)}
          />
        )}
        
        {/* Kanban Board */}
        <div className="board-container">
          {activeProjects.length === 0 ? (
            <div className="empty-state">
              <p>No projects selected. Toggle a project above to view tasks.</p>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <div className="board">
                {columns.map(column => (
                  <Column 
                    key={column.id} 
                    column={column}
                    showProject={activeProjects.length > 1}
                    onAddTask={() => setCreatingInColumn(column.title)}
                    onEditTask={setEditingTask}
                  />
                ))}
              </div>
              
              <DragOverlay dropAnimation={{ duration: 150, easing: 'ease-out' }}>
                {activeTask ? <TaskCard task={activeTask} isDragging /> : null}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </div>

      {(editingTask || creatingInColumn) && (
        <TaskModal
          task={editingTask}
          columnTitle={creatingInColumn}
          projects={projects}
          activeProjects={activeProjects}
          onSave={editingTask ? 
            (data) => handleUpdateTask(editingTask.id, data, editingTask._project) : 
            (data) => handleCreateTask(creatingInColumn, data)
          }
          onDelete={editingTask ? () => handleDeleteTask(editingTask.id, editingTask._project) : null}
          onClose={() => { setEditingTask(null); setCreatingInColumn(null); }}
        />
      )}

      {showPermissions && (
        <PermissionsModal 
          onClose={() => setShowPermissions(false)}
          onProjectsChange={fetchUserAndProjects}
        />
      )}
    </div>
  );
}

export default App;
