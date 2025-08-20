import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, TreeRepository, ILike, FindOptionsOrder } from 'typeorm';
import { Menu } from './entities/menu.entity';
import { CreateMenuDto } from './dto/create-menu.dto';
import { UpdateMenuDto } from './dto/update-menu.dto';
import { QueryMenuDto } from './dto/query-menu.dto';

function toSlug(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

@Injectable()
export class MenusService {
  private repo: TreeRepository<Menu>;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Menu) _repo: any,
  ) {
    this.repo = this.dataSource.getTreeRepository(Menu);
  }

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

        if (parent?.id) {
          qb.where('menu."parentId" = :pid', { pid: parent.id });
        } else {
          qb.where('menu."parentId" IS NULL');
        }

        const { max } = (await qb.getRawOne<{
          max: string | number | null;
        }>()) ?? { max: 0 };
        nextOrder = Number(max ?? 0) + 1;
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
      } catch (e: any) {
        if (e?.code === '23505') {
          throw new BadRequestException(
            'Duplicate slug or order for this parent',
          );
        }
        throw e;
      }
    });
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
    const menu = await this.findOne(id);

    if (dto.name) {
      menu.name = dto.name.trim();
      menu.slug = toSlug(dto.name);
    }
    if (dto.slug) {
      const slug = dto.slug.trim();
      const dupe = await this.repo.findOne({ where: { slug } });
      if (dupe && dupe.id !== id)
        throw new BadRequestException('Slug already exists');
      menu.slug = slug;
    }
    if (dto.order !== undefined) menu.order = dto.order;
    if (dto.isActive !== undefined) menu.isActive = dto.isActive;

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
    }

    return this.repo.save(menu);
  }

  async remove(id: number) {
    const menu = await this.findOne(id);
    if (menu.children?.length)
      throw new BadRequestException('Remove/move children first');

    await this.repo.remove(menu);
    return { success: true };
  }
}
