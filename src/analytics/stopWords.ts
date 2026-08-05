/**
 * Стоп-слова для токенизации метаданных приложений.
 *
 * Общие для обоих путей discovery. Многоязычные не для красоты: топ-частотных
 * слов описания на локальной витрине без них состоит из грамматики (для fr —
 * des/les/vous/pour/avec), и каждое такое слово уходит сидом в autocomplete,
 * а заодно разбавляет пул релевантности до бесполезности. Слова короче
 * 3 символов отсекает сама токенизация.
 */
export const STOP_WORDS = new Set([
  'the', 'and', 'for', 'app', 'apps', 'with', 'your', 'free', 'pro', 'plus',
  'a', 'an', 'to', 'of', 'on', 'in', '&', '-', 'by', 'is', 'it', 'as', 'or',
  'this', 'that', 'you', 'are', 'our', 'all', 'new', 'get', 'use', 'can',
  'has', 'have', 'from', 'about', 'also', 'they', 'them', 'their', 'will',
  'more', 'one', 'two', 'any', 'now', 'best', 'top', 'easy', 'simple',
  // Технический мусор/обрывки, не являющиеся поисковыми запросами.
  'com', 'www', 'net', 'org', 'inc', 'ltd', 'llc', 'http', 'https', 'been',
  // --- Неанглийские витрины ------------------------------------------------
  // Без них на локальной витрине топ-частотных слов описания состоит из
  // грамматики: для fr это des/les/vous/pour/avec, и каждое такое слово уходит
  // сидом в autocomplete ("dans" -> "danse gratuit"), а заодно попадает в пул
  // релевантности, обесценивая его — почти любая французская фраза делит с
  // приложением "les" или "des". Слова короче 3 букв отсекает words() сам.
  // fr
  'des', 'les', 'une', 'vous', 'pour', 'avec', 'votre', 'vos', 'dans', 'sur',
  'par', 'qui', 'que', 'est', 'sont', 'tout', 'tous', 'toute', 'plus', 'mais',
  'son', 'ses', 'ces', 'cette', 'nos', 'notre', 'leur', 'aux', 'ils', 'elle',
  'nous', 'jeu', 'jeux', 'application', 'gratuit', 'gratuite', 'meilleur',
  // de
  'der', 'die', 'das', 'und', 'für', 'fur', 'mit', 'den', 'dem', 'ein', 'eine',
  'einen', 'ist', 'sind', 'auf', 'aus', 'sie', 'ihr', 'ihre', 'nicht', 'auch',
  'aber', 'oder', 'wie', 'wir', 'von', 'zum', 'zur', 'kostenlos',
  // es / pt
  'los', 'las', 'del', 'para', 'con', 'por', 'una', 'unos', 'unas', 'que',
  'más', 'mas', 'como', 'pero', 'sus', 'este', 'esta', 'todos', 'todas',
  'você', 'voce', 'você', 'para', 'com', 'uma', 'não', 'nao', 'mais', 'seu',
  'sua', 'gratis', 'gratuito', 'juego', 'juegos', 'jogo', 'jogos',
  // it
  'per', 'con', 'della', 'delle', 'dei', 'degli', 'gli', 'gioco', 'giochi',
  'sono', 'questo', 'questa', 'anche', 'come', 'tuo', 'tua', 'gratuito',
  // nl
  'het', 'een', 'van', 'voor', 'met', 'zijn', 'niet', 'ook', 'maar', 'wij',
  // pl
  'oraz', 'dla', 'nie', 'jest', 'się', 'sie', 'które', 'ktore', 'wszystkie',
  'gra', 'gry', 'darmo', 'darmowa',
  // tr
  'için', 'icin', 'bir', 'bu', 'daha', 'çok', 'cok', 'oyun', 'oyunu',
  // ru / uk
  'для', 'что', 'как', 'все', 'это', 'или', 'вы', 'вас', 'ваш', 'ваша', 'ваши',
  'при', 'без', 'над', 'под', 'его', 'её', 'их', 'them', 'так', 'уже', 'ещё',
  'еще', 'может', 'можно', 'также', 'если', 'чтобы', 'быть', 'есть', 'приложение',
  'игра', 'игры', 'бесплатно', 'бесплатная',
  'для', 'що', 'як', 'все', 'це', 'або', 'ви', 'вас', 'ваш', 'ваша', 'ваші',
  'при', 'без', 'над', 'під', 'його', 'їх', 'так', 'вже', 'ще', 'може',
  'можна', 'також', 'якщо', 'щоб', 'бути', 'додаток', 'гра', 'ігри', 'безкоштовно',
]);
