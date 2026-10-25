import { describe, expect, it } from 'vitest';
import { dumpYaml, parseYaml, parseYamlAll } from './yaml.js';

describe('yaml', () => {
  it('reads a GitHub Actions workflow', () => {
    const doc = parseYaml(`name: CI  # comment
on:
  push:
    branches: [main, "release/*"]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python: ['3.11', '3.12']
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: |
          echo "hi # not a comment"
          make test
        env: { CI: "true", LEVEL: 2 }
      - run: >-
          echo one
          two
`);
    expect(doc).toEqual({
      name: 'CI',
      on: { push: { branches: ['main', 'release/*'] }, pull_request: '' },
      jobs: {
        test: {
          'runs-on': 'ubuntu-latest',
          strategy: { matrix: { python: ['3.11', '3.12'] } },
          steps: [{ uses: 'actions/checkout@v4' }, { name: 'Run tests', run: 'echo "hi # not a comment"\nmake test\n', env: { CI: 'true', LEVEL: '2' } }, { run: 'echo one two' }],
        },
      },
    });
  });

  it('reads several Kubernetes documents, lists at the key column and anchors', () => {
    const docs = parseYamlAll(`apiVersion: apps/v1
kind: Deployment
metadata:
  labels: &l
    app: web
spec:
  template:
    metadata:
      labels: *l
    spec:
      containers:
      - name: web
        image: nginx:1.27
        ports:
        - containerPort: 80
---
base: &b { a: 1 }
derived:
  <<: *b
  c: 3
`);
    expect(docs).toHaveLength(2);
    const d = docs[0] as Record<string, any>;
    expect(d.spec.template.metadata.labels).toEqual({ app: 'web' });
    expect(d.spec.template.spec.containers[0].ports[0].containerPort).toBe('80');
    expect((docs[1] as Record<string, any>).derived).toEqual({ a: '1', c: '3' });
  });

  it('round-trips through the dumper', () => {
    const v = { kind: 'Service', spec: { ports: [{ port: '80', name: 'http' }], selector: { app: 'web' } }, note: 'a: b', script: 'line1\nline2\n' };
    expect(parseYaml(dumpYaml(v))).toEqual({ ...v, spec: { ...v.spec } });
  });

  it('reports a bad line', () => {
    expect(() => parseYaml('a: 1\n  b: 2\n')).toThrow(/line 2/);
  });
});
