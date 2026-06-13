import { Building } from './building.entity';
import { DomainError } from '../../common/errors/domain-error';

describe('Building entity', () => {
  it('create()로 만들면 id는 null, 소유자가 설정된다', () => {
    const building = Building.create({
      ownerId: 'owner1',
      name: '래미안',
      address: '서울시 강남구',
    });

    expect(building.id).toBeNull();
    expect(building.ownerId).toBe('owner1');
    expect(building.isOwnedBy('owner1')).toBe(true);
    expect(building.isOwnedBy('other')).toBe(false);
  });

  it('ownerId가 비면 예외', () => {
    expect(() =>
      Building.create({ ownerId: '', name: '래미안', address: '주소' }),
    ).toThrow(DomainError);
  });
});
