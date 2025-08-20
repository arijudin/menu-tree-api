import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
} from '@nestjs/common';
import { MenusService } from './menus.service';
import { CreateMenuDto } from './dto/create-menu.dto';
import { UpdateMenuDto } from './dto/update-menu.dto';
import { QueryMenuDto } from './dto/query-menu.dto';

@Controller('menus')
export class MenusController {
  constructor(private readonly service: MenusService) { }

  @Get('tree')
  async getTree() {
    const data = await this.service.findTree();
    return { data, success: true };
  }

  @Get()
  async getFlat(@Query() q: QueryMenuDto) {
    const data = await this.service.findFlat(q);
    return { data, success: true };
  }

  @Get(':id')
  async getOne(@Param('id') id: string, @Query('tree') tree?: string) {
    const menuId = Number(id);

    if (tree === 'true') {
      const data = await this.service.findTreeById(menuId);
      return { data, success: true };
    }

    const data = await this.service.findOne(menuId);
    return { data, success: true };
  }

  @Post()
  async create(@Body() dto: CreateMenuDto) {
    const data = await this.service.create(dto);
    return { data, success: true, message: 'Menu created.' };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateMenuDto) {
    const data = await this.service.update(Number(id), dto);
    return { data, success: true, message: 'Menu updated.' };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.service.remove(Number(id));
    return { success: true, message: 'Menu removed.' };
  }
}
