# Menu Service (BE) — NestJS + TypeORM (PostgreSQL) + Materialized Path

A NestJS service to manage hierarchical **menus** using TypeORM's **materialized-path** trees.

---

## Features

- CRUD menus with parent–child relations
- Tree endpoints:
  - **Root list** (all root nodes with children)
  - **Subtree by id** (`findDescendantsTree`)
- Auto **ordering per sibling group** (`order` increment)
- Robust `create()` with **transaction + advisory lock** to avoid race conditions
- Safe error handling (`catch (err: unknown)` + narrowing)
- Optional `depth` in responses
- Pagination for flat list

---

## Requirements & Environment

- Node.js 21+
- PostgreSQL 13+
- ENV:
```
DATABASE_URL=postgres://user:pass@localhost:5432/yourdb
# or individual vars:
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=yourdb
POSTGRES_USER=user
POSTGRES_PASSWORD=pass
```

CORS: enable for FE domain.

---

## Install & Run

```bash
pnpm install
pnpm start:dev
# or npm run start:dev
```

Build/Prod:
```bash
pnpm build && pnpm start:prod
```

Lint:
```bash
pnpm lint
```

---

## Entity (Materialized Path)

```ts
@Tree('materialized-path')
@Entity('menus')
export class Menu {
  @PrimaryGeneratedColumn() id: number;

  @Index({ unique: true })
  @Column({ type: 'uuid', unique: true, default: () => 'uuid_generate_v4()' })
  uid: string;

  @Index({ unique: true }) @Column({ length: 150 }) name: string;
  @Index({ unique: true }) @Column({ length: 180 }) slug: string;
  @Column({ type: 'int', default: 0 }) order: number;
  @Column({ type: 'boolean', default: true }) isActive: boolean;

  @RelationId((m: Menu) => m.parent) parentId?: number | null;
  @TreeChildren() children: Menu[];
  @TreeParent() parent: Menu | null;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;

  // NOTE: Do NOT decorate mpath with @Column for materialized-path
  // mpath?: string | null
}
```

**Important:** do not `mpath` as `@Column`. If need, get it via QueryBuilder `.addSelect('menu.mpath')` or calculate `depth` recursive on service.

---

## Service — `create()` (robust version)

- Transaction + `pg_advisory_xact_lock(parentId||0)`
- Quote `"order"` (reserved keyword)
- Narrow errors from `unknown`

```ts
async create(dto: CreateMenuDto) {
  const slug = dto.slug?.trim() || toSlug(dto.name);

  const exists = await this.repo.findOne({ where: { slug } });
  if (exists) throw new BadRequestException('Slug already exists');

  let parent: Menu | null = null;
  if (dto.parentId) {
    parent = await this.repo.findOne({ where: { id: dto.parentId } });
    if (!parent) throw new NotFoundException('Parent not found');
  }

  return this.dataSource.transaction(async (em) => {
    const menuRepo = em.getRepository(Menu);
    const lockKey = parent?.id ?? 0;
    await em.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

    let nextOrder: number;
    if (dto.order != null) {
      nextOrder = dto.order;
    } else {
      const qb = menuRepo
        .createQueryBuilder('menu')
        .select('COALESCE(MAX(menu."order"), 0)', 'max');

      if (parent?.id) qb.where('menu."parentId" = :pid', { pid: parent.id });
      else qb.where('menu."parentId" IS NULL');

      const raw = await qb.getRawOne<{ max: string | number | null }>();
      nextOrder = Number(raw?.max ?? 0) + 1;
    }

    const entity = menuRepo.create({
      name: dto.name.trim(),
      slug,
      order: nextOrder,
      isActive: dto.isActive ?? true,
      parent,
    });

    try {
      return await menuRepo.save(entity);
    } catch (err: unknown) {
      const code = getPgErrorCode(err);
      if (code === '23505') {
        throw new BadRequestException('Duplicate slug or order for this parent');
      }
      throw err;
    }
  });
}

// helper
import { QueryFailedError } from 'typeorm';
function getPgErrorCode(err: unknown): string | undefined {
  if (err instanceof QueryFailedError) {
    const drv = err.driverError as Record<string, unknown> | undefined;
    const code = drv && typeof drv.code === 'string' ? drv.code : undefined;
    return code;
  }
  if (typeof err === 'object' && err !== null) {
    const rec = err as Record<string, unknown>;
    if (typeof rec.code === 'string') return rec.code;
  }
  return undefined;
}
```

---

## Tree Fetching

- **Root list**: `this.repo.findTrees({ relations: ['children'] })`
- **Subtree by id** (preferred): find root once, then
  `this.repo.findDescendantsTree(root, { relations: ['children'] })`

Add `depth` on the fly:
```ts
function addDepth<T extends { children?: T[] }>(node: T, depth = 0): T & { depth: number } {
  return {
    ...(node as any),
    depth,
    children: (node.children ?? []).map((c) => addDepth(c as any, depth + 1)),
  };
}
```

---

## Endpoints (example)

```
GET    /menus?page=1                 # flat list + pagination
GET    /menus/tree                   # all root trees
GET    /menus/:id?tree=true          # subtree by id
POST   /menus                        # create
PATCH  /menus/:id                    # update
DELETE /menus/:id                    # delete
```

### DTOs (example)
```ts
export class CreateMenuDto {
  @IsString() name: string;
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsInt() parentId?: number;
  @IsOptional() @IsInt() order?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
```

---

## Database Safety Nets

**Uniqueness** for ordering per level (choose one):

**A) Partial indexes**
```sql
CREATE UNIQUE INDEX IF NOT EXISTS menus_root_order_uniq
ON "menus" ("order") WHERE "parentId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS menus_parent_order_uniq
ON "menus" ("parentId", "order") WHERE "parentId" IS NOT NULL;
```

**B) Expression index (coalesce)**
```sql
CREATE UNIQUE INDEX IF NOT EXISTS menus_parent_coalesced_order_uniq
ON "menus" (COALESCE("parentId", 0), "order");
```

Also keep a unique index on `slug` (as in entity).

---

## Error Handling

- `catch (err: unknown)` + safe narrowing (see helper above)
- Return 400 for duplicate slug/order (PG code `23505`)
- 404 for missing parent/target
- Validate inputs via `class-validator` in DTOs

---

## Testing Ideas

- Unit test `create()` ordering logic and transaction path
- Integration test concurrent creates (simulate order assignment)
- Test tree endpoints depth correctness

---

## Deployment Notes

- Run migrations (including indexes above)
- Ensure `uuid-ossp` extension if using `uuid_generate_v4()`
  ```sql
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  ```
- Configure CORS for FE domain
- Health check endpoint for infra
