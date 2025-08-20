import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Tree,
  TreeChildren,
  TreeParent,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  RelationId,
} from 'typeorm';

@Tree('materialized-path')
@Entity('menus')
export class Menu {
  @PrimaryGeneratedColumn()
  id: number;

  @Index({ unique: true })
  @Column({ type: 'uuid', unique: true, default: () => 'uuid_generate_v4()' })
  uid: string;

  @Index({ unique: true })
  @Column({ length: 150 })
  name: string;

  @Index({ unique: true })
  @Column({ length: 180 })
  slug: string;

  @Column({ type: 'int', default: 0 })
  order: number;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @RelationId((menu: Menu) => menu.parent)
  parentId?: number | null;

  mpath?: string | null;

  @Column({
    type: 'int',
    generatedType: 'STORED',
    asExpression: `GREATEST(0, regexp_count(COALESCE(mpath, ''), '\\.') - 1)`,
  })
  depth!: number;

  @TreeChildren()
  children: Menu[];

  @TreeParent()
  parent: Menu | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
