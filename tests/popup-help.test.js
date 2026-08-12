const { idleStateFor } = require('../src/popup-help');
const { PLATFORM } = require('../src/shared/constants');

describe('idleStateFor', () => {
  test('Uber Eats checkout URL → uber-checkout', () => {
    expect(idleStateFor('https://www.ubereats.com/gb/checkout?foo=1'))
      .toEqual({ key: 'uber-checkout', platform: PLATFORM.UBER_EATS });
  });

  test('Uber Eats store page → uber-other', () => {
    expect(idleStateFor('https://www.ubereats.com/gb/store/some-place/abc123'))
      .toEqual({ key: 'uber-other', platform: PLATFORM.UBER_EATS });
  });

  test('Uber Eats home → uber-other', () => {
    expect(idleStateFor('https://www.ubereats.com/gb/'))
      .toEqual({ key: 'uber-other', platform: PLATFORM.UBER_EATS });
  });

  test('Deliveroo menu → destination with Deliveroo platform', () => {
    expect(idleStateFor('https://www.deliveroo.co.uk/menu/london/place'))
      .toEqual({ key: 'destination', platform: PLATFORM.DELIVEROO });
  });

  test('Just Eat menu → destination with Just Eat platform', () => {
    expect(idleStateFor('https://www.just-eat.co.uk/restaurants-x/menu'))
      .toEqual({ key: 'destination', platform: PLATFORM.JUST_EAT });
  });

  test('unrelated site → elsewhere', () => {
    expect(idleStateFor('https://www.google.com/'))
      .toEqual({ key: 'elsewhere', platform: null });
  });

  test('undefined url → elsewhere', () => {
    expect(idleStateFor(undefined)).toEqual({ key: 'elsewhere', platform: null });
  });

  test('empty string url → elsewhere', () => {
    expect(idleStateFor('')).toEqual({ key: 'elsewhere', platform: null });
  });
});
