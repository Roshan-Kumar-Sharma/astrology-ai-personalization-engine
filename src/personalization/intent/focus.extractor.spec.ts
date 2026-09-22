import { extractFocus } from './focus.extractor';

describe('focus extractor', () => {
  it('names the planet a question is about', () => {
    expect(extractFocus('Is Sade Sati affecting me?')).toMatchObject({
      planets: ['Saturn'],
      signals: ['Sade Sati'],
    });
    expect(extractFocus('How is my Jupiter transit?').planets).toEqual(['Jupiter']);
    expect(extractFocus('What does Rahu mean for my career?').planets).toEqual(['Rahu']);
  });

  it('reads the Hindi and Hinglish names', () => {
    expect(extractFocus('Kya meri saadhe saati chal rahi hai?').planets).toEqual(['Saturn']);
    expect(extractFocus('shani ki dhaiya kab khatam hogi').planets).toEqual(['Saturn']);
    expect(extractFocus('क्या मेरी साढ़े साती चल रही है?').planets).toEqual(['Saturn']);
    expect(extractFocus('बृहस्पति का गोचर कैसा है').planets).toEqual(['Jupiter']);
    expect(extractFocus('राहु केतु का असर').planets).toEqual(['Rahu', 'Ketu']);
  });

  it('can name more than one planet', () => {
    expect(extractFocus('Saturn and Jupiter both look bad this year').planets).toEqual([
      'Saturn',
      'Jupiter',
    ]);
  });

  it('treats a bare "transit" or "gochar" as a request about all of them', () => {
    expect(extractFocus('What are the current transits doing to me?')).toMatchObject({
      planets: [],
      gochar: true,
    });
    expect(extractFocus('Abhi ka gochar kaisa hai?').gochar).toBe(true);
  });

  describe('false positives it must not produce', () => {
    it('"guru ji" is the astrologer, not Jupiter', () => {
      expect(extractFocus('Guru ji, should I change my job?').planets).toEqual([]);
      expect(extractFocus('My guru told me to wait').planets).toEqual([]);
      // The compound form is the planet.
      expect(extractFocus('Guru gochar this year?').planets).toEqual(['Jupiter']);
    });

    it('"shanivar" is Saturday, not Saturn', () => {
      expect(extractFocus('Shanivar ko interview hai, kaisa rahega?').planets).toEqual([]);
    });

    it('an ordinary question names nothing', () => {
      expect(extractFocus('Should I change my job this month?')).toEqual({
        planets: [],
        gochar: false,
        signals: [],
      });
    });
  });
});
