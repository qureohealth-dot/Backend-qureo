const express = require('express');
const request = require('supertest');

process.env.JWT_SECRET = 'admin-signin-test-secret';
process.env.ADMIN_LOGIN_USERNAME = 'test-console';
process.env.ADMIN_LOGIN_PASSWORD = 'test-password';

const authRoutes = require('../routes/auth');
const auth = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminAuth');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.get('/api/admin-check', auth, requireAdmin, (req, res) => res.json({ ok: true }));

describe('admin console sign-in', () => {
  it('issues an admin-only token for configured credentials', async () => {
    const signIn = await request(app)
      .post('/api/auth/admin-signin')
      .send({ username: 'test-console', password: 'test-password' });

    expect(signIn.status).toBe(200);
    expect(signIn.body.token).toBeTruthy();
    expect(signIn.body.user.id).toBe('admin-console');

    const protectedResponse = await request(app)
      .get('/api/admin-check')
      .set('Authorization', `Bearer ${signIn.body.token}`);

    expect(protectedResponse.status).toBe(200);
    expect(protectedResponse.body).toEqual({ ok: true });
  });

  it('rejects incorrect credentials', async () => {
    const response = await request(app)
      .post('/api/auth/admin-signin')
      .send({ username: 'test-console', password: 'wrong-password' });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Incorrect username or password');
  });
});