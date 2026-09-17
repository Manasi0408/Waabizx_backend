require('dotenv').config();
const db = require('../config/db');
const { User } = require('../models');
const Project = require('../models/Project');

(async () => {
  const email = process.env.AISENSY_DIRECT_API_EMAIL;
  const pid = Number(process.env.AISENSY_DIRECT_API_PROJECT_ID);
  const base = process.env.AISENSY_DIRECT_API_BASE || '(not set — defaults to https://backend.aisensy.com)';

  console.log('\n=== Direct API .env ===');
  console.log('AISENSY_DIRECT_API_BASE:', base);
  console.log('AISENSY_DIRECT_API_EMAIL:', email);
  console.log('AISENSY_DIRECT_API_PROJECT_ID:', pid);

  const user = await User.findOne({ where: { email: String(email || '').toLowerCase() } });
  if (!user) {
    console.log('\n❌ User not found for email:', email);
    process.exit(1);
  }
  console.log('\n=== User ===');
  console.log({ id: user.id, email: user.email, role: user.role, projectId: user.projectId });

  const pass = process.env.AISENSY_DIRECT_API_PASSWORD;
  const passOk = await user.comparePassword(pass).catch(() => false);
  console.log('Password matches .env:', passOk ? 'YES' : 'NO — wrong AISENSY_DIRECT_API_PASSWORD');

  const [owned] = await db.query(
    'SELECT id, project_name FROM projects WHERE user_id = ? ORDER BY id DESC',
    [user.id]
  );
  console.log('\n=== Projects this user OWNS ===');
  console.log(owned.length ? owned : '(none)');

  const project = await Project.findById(pid);
  if (!project) {
    console.log('\n❌ Project', pid, 'does not exist');
  } else {
    const [owners] = await db.query(
      'SELECT id, email FROM users WHERE id = ?',
      [project.user_id]
    );
    console.log('\n=== Project', pid, '===');
    console.log({ name: project.project_name, owner_user_id: project.user_id, owner_email: owners[0]?.email });
    console.log(
      'Access:',
      Number(project.user_id) === Number(user.id)
        ? 'OK (owner)'
        : Number(user.projectId) === pid
          ? 'OK (assigned projectId)'
          : 'DENIED — this user does not own or belong to this project'
    );
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
