// Contract endpoints (docs/API_MAP.md §2.6). The status map, scope and views
// live in the service.

import express, { Router, type Response } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { CreateBody, ListQuery, RenewBody, TransitionBody, type ContractService } from './service.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });
const DocParam = z.object({ id: z.coerce.number().int().positive(), docId: z.coerce.number().int().positive() });

export function createContractsRouter(db: Db, contracts: ContractService, maxUploadBytes: number) {
  const r = Router();
  const rid = (res: Response) => res.locals.requestId as string;

  r.get('/contracts', authorize('contracts.read'), async (req, res) => { res.json(await contracts.list(authOf(res), ListQuery.parse(req.query))); });
  r.get('/contracts/me', async (_req, res) => { res.json(await contracts.listOwn(authOf(res))); });
  r.get('/contracts/creatable', authorize('contracts.manage'), async (_req, res) => { res.json(await contracts.creatable(authOf(res))); });
  r.get('/contracts/renewable', authorize('contracts.manage'), async (_req, res) => { res.json(await contracts.renewable(authOf(res))); });
  r.post('/contracts', authorize('contracts.manage'), idempotent(db, 'contracts.create'), async (req, res) => {
    res.status(201).json(await contracts.create(authOf(res), CreateBody.parse(req.body), rid(res)));
  });
  r.get('/contracts/:id', async (req, res) => { res.json(await contracts.get(authOf(res), IdParam.parse(req.params).id)); });
  r.post('/contracts/:id/renew', authorize('contracts.manage'), idempotent(db, 'contracts.renew'), async (req, res) => {
    res.status(201).json(await contracts.renew(authOf(res), IdParam.parse(req.params).id, RenewBody.parse(req.body ?? {}), rid(res)));
  });
  r.post('/contracts/:id/transition', authorize('contracts.manage'), async (req, res) => {
    res.json(await contracts.transition(authOf(res), IdParam.parse(req.params).id, TransitionBody.parse(req.body), rid(res)));
  });

  // Contract copy: raw PDF body, name in X-File-Name (same as credential evidence).
  r.post('/contracts/:id/documents', authorize('contracts.manage'), express.raw({ type: () => true, limit: maxUploadBytes + 1 }), async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const name = req.get('x-file-name');
    res.status(201).json(await contracts.upload(authOf(res), IdParam.parse(req.params).id, bytes, req.get('content-type'), name ? decodeURIComponent(name) : undefined, rid(res)));
  });
  r.get('/contracts/:id/documents', async (req, res) => { res.json(await contracts.listDocuments(authOf(res), IdParam.parse(req.params).id)); });
  r.get('/contracts/:id/documents/:docId', async (req, res) => {
    const { id, docId } = DocParam.parse(req.params);
    const file = await contracts.download(authOf(res), id, docId, rid(res));
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
    }).send(file.bytes);
  });

  return r;
}
