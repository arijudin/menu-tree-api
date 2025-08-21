import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  TreeRepository,
  ILike,
  FindOptionsOrder,
  QueryFailedError,
} from 'typeorm';
import { Menu } from './entities/menu.entity';
import { CreateMenuDto } from './dto/create-menu.dto';
import { UpdateMenuDto } from './dto/update-menu.dto';
import { QueryMenuDto } from './dto/query-menu.dto';
import { isEmptyOrHyphens, unicodeSlug } from 'utils/slug.util';
import { randomUUID } from 'node:crypto';

type WithCode = { code?: unknown };

@Injectable()
export class MenusService {
  private repo: TreeRepository<Menu>;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Menu) _repo: any,
  ) {
    this.repo = this.dataSource.getTreeRepository(Menu);
  }

  private async ensureUniqueSlug(base: string): Promise<string> {
    if (!(await this.repo.exist({ where: { slug: base } }))) return base;

    let i = 2;
    while (await this.repo.exist({ where: { slug: `${base}-${i}` } })) {
      i++;
    }
    return `${base}-${i}`;
  }

  private getPgErrorCode(err: unknown): string | undefined {
    if (err instanceof QueryFailedError) {
      const drv: unknown = (err as QueryFailedError).driverError;
      if (typeof drv === 'object' && drv !== null) {
        const maybe = drv as WithCode;
        if (typeof maybe.code === 'string') return maybe.code;
      }
      return undefined;
    }

    if (typeof err === 'object' && err !== null) {
      const maybe = err as WithCode;
      if (typeof maybe.code === 'string') return maybe.code;
    }

    return undefined;
  }

  async create(dto: CreateMenuDto) {
    const raw = dto.slug?.trim();
    const sourceForSlug = !isEmptyOrHyphens(raw) ? raw! : (dto.name ?? '');

    let baseSlug = unicodeSlug(sourceForSlug);

    if (!baseSlug) {
      baseSlug = `menu-${randomUUID().slice(0, 8)}`;
    }

    const slug = await this.ensureUniqueSlug(baseSlug);

    let parent: Menu | null = null;
    if (dto.parentId) {
      parent = await this.repo.findOne({ where: { id: dto.parentId } });
      if (!parent) throw new NotFoundException('Parent not found');
    }

    let order = dto.order;
    if (order == null) {
      const qb = this.repo
        .createQueryBuilder('menu')
        .select('COALESCE(MAX(menu."order"), 0)', 'max');

      if (parent?.id) {
        qb.where('menu."parentId" = :pid', { pid: parent.id });
      } else {
        qb.where('menu."parentId" IS NULL');
      }

      const rawMax = await qb.getRawOne<{ max: string | number | null }>();
      order = Number(rawMax?.max ?? 0) + 1;
    }

    const entity = this.repo.create({
      name: dto.name.trim(),
      slug,
      order,
      isActive: dto.isActive ?? true,
      parent,
    });

    try {
      return await this.repo.save(entity);
    } catch (err: unknown) {
      const code = this.getPgErrorCode(err);
      if (code === '23505') {
        throw new BadRequestException(
          'Duplicate slug or order for this parent',
        );
      }
      throw err;
    }
  }

  async findTree() {
    return this.repo.findTrees({
      relations: ['children'],
      // depth: 2,
    });
  }

  async findTreeById(id: number) {
    const trees = await this.repo.findTrees({
      relations: ['children'],
    });

    const root = trees.find((t) => t.id === id);
    if (!root) throw new NotFoundException('Menu not found');
    return root;
  }

  async findFlat(q: QueryMenuDto) {
    const page = Number(q.page ?? 1);
    const limit = Math.min(Number(q.limit ?? 20), 100);
    const skip = (page - 1) * limit;

    const where = q.search
      ? [{ name: ILike(`%${q.search}%`) }, { slug: ILike(`%${q.search}%`) }]
      : {};

    const sortBy: keyof Menu = q.sortBy ?? 'createdAt';
    const sortOrder: 'ASC' | 'DESC' = (q.sortOrder ?? 'asc').toUpperCase() as
      | 'ASC'
      | 'DESC';

    const order: FindOptionsOrder<Menu> = {
      [sortBy]: sortOrder,
    };

    const [items, total] = await this.repo.findAndCount({
      where,
      order,
      skip,
      take: limit,
      relations: ['parent', 'children'],
    });

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: number) {
    const item = await this.repo.findOne({
      where: { id },
    });
    if (!item) throw new NotFoundException('Menu not found');
    return item;
  }

  async update(id: number, dto: UpdateMenuDto) {
    const menu = await this.repo.findOne({ where: { id } });
    if (!menu) throw new NotFoundException('Menu not found');

    // 1) Name
    let nameChanged = false;
    if (dto.name != null) {
      const trimmed = dto.name.trim();
      nameChanged = trimmed !== '' && trimmed !== menu.name;
      menu.name = trimmed;
    }

    // 2) Slug
    if (dto.slug !== undefined) {
      // explicit override / reslug via slug field
      const raw = dto.slug?.trim() ?? '';
      const source = !isEmptyOrHyphens(raw)
        ? raw
        : (dto.name?.trim() ?? menu.name ?? '');
      let baseSlug = unicodeSlug(source);
      if (!baseSlug) baseSlug = `menu-${randomUUID().slice(0, 8)}`;
      if (baseSlug !== menu.slug) {
        menu.slug = await this.ensureUniqueSlug(baseSlug);
      }
    } else if (nameChanged) {
      // ⬅️ auto-reslug when name changed AND slug not provided
      const source = menu.name ?? '';
      let baseSlug = unicodeSlug(source);
      if (!baseSlug) baseSlug = `menu-${randomUUID().slice(0, 8)}`;
      if (baseSlug !== menu.slug) {
        menu.slug = await this.ensureUniqueSlug(baseSlug);
      }
    }

    // 3) Parent (opsional, jika kamu izinkan pindah parent di update)
    if (dto.parentId !== undefined) {
      if (dto.parentId === null) {
        menu.parent = null;
      } else {
        if (dto.parentId === id) {
          throw new BadRequestException('Cannot set parent to itself');
        }
        const newParent = await this.repo.findOne({
          where: { id: dto.parentId },
        });
        if (!newParent) throw new NotFoundException('New parent not found');

        const descendants = await this.repo.findDescendants(menu);
        if (descendants.some((d) => d.id === newParent.id)) {
          throw new BadRequestException(
            'Cannot move a node into its descendant',
          );
        }
        menu.parent = newParent;
      }
      // (opsional) jika parent berubah, kamu mungkin ingin menghitung ulang "order"
    }

    // 4) Order/isActive (opsional)
    if (dto.order !== undefined && dto.order !== null) {
      menu.order = dto.order;
    }
    if (dto.isActive !== undefined && dto.isActive !== null) {
      menu.isActive = dto.isActive;
    }

    try {
      return await this.repo.save(menu);
    } catch (err: unknown) {
      const code = this.getPgErrorCode(err);
      if (code === '23505') {
        throw new BadRequestException(
          'Duplicate slug or order for this parent',
        );
      }
      throw err;
    }
  }

  async remove(id: number) {
    const menu = await this.findOne(id);
    if (menu.children?.length)
      throw new BadRequestException('Remove/move children first');

    await this.repo.remove(menu);
    return { success: true };
  }
}
