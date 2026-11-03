/*
 * Test data taken from the real spreadsheet (Achats / Ventes as of 03/11/2026)
 * and from a real /api/marketplace?mine=1 answer (trimmed to useful fields).
 */
'use strict';

const ME = '205ffe34-550c-402d-b1ce-eabaf5ece82c';

// [ID, Date/heure (Paris), Carte, Rareté, Prix, Vendeur, Inclure]
const ACHATS_ROWS = [
  ['A01', '30/10/2026 23:44', 'Velociraptor', 'SR', 549, 'Himmel_', 'Non'],
  ['A02', '31/10/2026 12:39', 'Triceratops', 'SR', 889, 'snezaa', 'Non'],
  ['A03', '31/10/2026 12:39', 'Velociraptor', 'SR', 350, 'picrate', 'Oui'],
  ['A04', '31/10/2026 15:28', 'Tyrannosaurus', 'UR', 1641, 'laure0756', 'Oui'],
  ['A05', '31/10/2026 14:43', 'Triceratops', 'SR', 900, 'bulox', 'Oui'],
  ['A06', '31/10/2026 16:26', 'Ankylosaurus', 'SR', 370, 'AlexiZi', 'Non'],
  ['A07', '31/10/2026 23:24', 'Giganotosaurus', 'SR', 127, 'nonogrosloio', 'Oui'],
  ['A08', '31/10/2026 23:40', 'Ankylosaurus', 'SR', 130, 'PRobin', 'Oui'],
  ['A09', '01/11/2026 12:25', 'Giganotosaurus', 'SR', 300, 'Wikilogrammes', 'Oui'],
  ['A10', '01/11/2026 12:25', 'Giganotosaurus', 'SR', 100, 'Aenergy', 'Oui'],
  ['A11', '01/11/2026 12:25', 'Giganotosaurus', 'SR', 333, 'Ailurus fulgens', 'Oui'],
  ['A12', '01/11/2026 20:03', 'Ankylosaurus', 'SR', 250, 'plipio13', 'Non'],
  ['A13', '02/11/2026 19:47', 'Velociraptor', 'SR', 717, 'Grogouille', 'Non'],
  ['A14', '02/11/2026 20:04', 'Triceratops', 'SR', 772, 'Snickers', 'Oui'],
  ['A15', '02/11/2026 20:25', 'Allosaurus', 'SR', 222, 'Blueberry', 'Oui'],
  ['A16', '02/11/2026 20:47', 'Giganotosaurus', 'SR', 350, 'Papouchnek', 'Oui'],
  ['A17', '03/11/2026 01:45', 'Argentinosaurus', 'SR', 111, 'Antonio2116', 'Oui'],
  ['A18', '03/11/2026 01:45', 'Triceratops', 'SR', 1200, 'CuteName', 'Oui'],
  ['A19', '03/11/2026 13:00', 'Deinonychus', 'SR', 271, 'nonoboc', 'Oui'],
  ['A20', '03/11/2026 15:33', 'Triceratops', 'SR', 1210, 'nadeshiko', 'Oui'],
  ['A21', '03/11/2026 16:57', 'Triceratops', 'SR', 1200, 'brunolegros', 'Oui']
];

// [ID, Date/heure (Paris), Carte, Rareté, Prix, Statut]
const VENTES_ROWS = [
  ['V01', '31/10/2026 23:47', 'Tyrannosaurus', 'UR', 2145, 'Vendue'],
  ['V02', '31/10/2026 23:47', 'Ankylosaurus', 'SR', 400, 'Non vendue'],
  ['V03', '01/11/2026 11:52', 'Triceratops', 'SR', 1375, 'Vendue'],
  ['V04', '01/11/2026 11:52', 'Giganotosaurus', 'SR', 350, 'Non vendue'],
  ['V05', '01/11/2026 11:52', 'Ankylosaurus', 'SR', 450, 'Non vendue'],
  ['V06', '01/11/2026 13:30', 'Giganotosaurus', 'SR', 450, 'Non vendue'],
  ['V07', '01/11/2026 21:30', 'Giganotosaurus', 'SR', 485, 'Vendue'],
  ['V08', '02/11/2026 00:01', 'Giganotosaurus', 'SR', 450, 'Non vendue'],
  ['V09', '02/11/2026 00:01', 'Ankylosaurus', 'SR', 450, 'Non vendue'],
  ['V10', '02/11/2026 01:01', 'Ankylosaurus', 'SR', 450, 'Non vendue'],
  ['V11', '02/11/2026 01:01', 'Giganotosaurus', 'SR', 450, 'Non vendue'],
  ['V12', '02/11/2026 16:01', 'Giganotosaurus', 'SR', 450, 'Non vendue'],
  ['V13', '02/11/2026 18:30', 'Ankylosaurus', 'SR', 450, 'Non vendue'],
  ['V14', '02/11/2026 19:07', 'Ankylosaurus', 'SR', 450, 'Vendue'],
  ['V15', '02/11/2026 19:07', 'Giganotosaurus', 'SR', 450, 'Non vendue'],
  ['V16', '02/11/2026 22:37', 'Triceratops', 'SR', 1300, 'Vendue'],
  ['V17', '02/11/2026 23:04', 'Giganotosaurus', 'SR', 450, 'Vendue'],
  ['V18', '02/11/2026 23:04', 'Allosaurus', 'SR', 605, 'Vendue'],
  ['V19', '03/11/2026 09:23', 'Velociraptor', 'SR', 950, 'Vendue'],
  ['V20', '03/11/2026 10:50', 'Giganotosaurus', 'SR', 600, 'Vendue'],
  ['V21', '03/11/2026 18:31', 'Argentinosaurus', 'SR', 380, 'Vendue'],
  ['V22', '03/11/2026 18:31', 'Triceratops', 'SR', 1500, 'Non vendue'],
  ['V23', '03/11/2026 18:31', 'Giganotosaurus', 'SR', 750, 'Vendue']
];

// history[]: [id prefix, end_at (UTC), title, rarity, S|U, price (final if sold, base_amount if not), buyer]
const HISTORY = [
  ['c989f609', '2026-11-03T17:32:07', 'Giganotosaurus', 'SR', 'S', 750, 'Jørgen15'],
  ['13c0146a', '2026-11-03T17:31:39', 'Triceratops', 'SR', 'U', 1500],
  ['885592dc', '2026-11-03T17:31:21', 'Argentinosaurus', 'SR', 'S', 380, 'MrDadou69'],
  ['70482d9c', '2026-11-03T14:32:33', 'Alexander Kareline', 'SR', 'U', 1],
  ['e644fb3b', '2026-11-03T14:30:45', 'Source Q', 'UR', 'S', 1, 'Bilawal'],
  ['ff6360e1', '2026-11-03T11:30:03', 'Sophie Favier', 'UR', 'S', 2, 'Original-Habibi'],
  ['f4c264e4', '2026-11-03T11:29:42', 'Source Q', 'UR', 'U', 1],
  ['4055436d', '2026-11-03T10:15:50', 'Pornographie au Japon', 'SR', 'U', 50],
  ['ab7376df', '2026-11-03T10:05:13', 'Giganotosaurus', 'SR', 'S', 600, 'Pauloooooooo'],
  ['bc16528d', '2026-11-03T10:04:15', 'Velociraptor', 'SR', 'S', 950, 'πThon 5'],
  ['00ad5c25', '2026-11-02T23:28:49', 'Marlène Schiappa', 'UR', 'S', 13, 'Piého Plancher'],
  ['4ad02b9a', '2026-11-02T22:11:35', 'Allosaurus', 'SR', 'S', 605, 'grénouille'],
  ['74ee8e56', '2026-11-02T22:04:47', 'Giganotosaurus', 'SR', 'S', 450, 'wikiAlextheone'],
  ['d84ce2b5', '2026-11-02T22:04:08', 'Triceratops', 'SR', 'S', 1300, 'Louisoooo'],
  ['840b4f6e', '2026-11-02T22:02:42', 'Velociraptor', 'SR', 'U', 980],
  ['80ade102', '2026-11-02T20:35:10', 'Giganotosaurus', 'SR', 'U', 450],
  ['3d3b56f8', '2026-11-02T20:37:06', 'Sagittarius A*', 'SR', 'S', 800, 'Nebx00'],
  ['cd6c5dec', '2026-11-02T20:34:30', 'Ankylosaurus', 'SR', 'S', 450, 'Torubis'],
  ['3bab749b', '2026-11-02T20:30:16', 'Vladimir Horowitz', 'SR', 'S', 50, 'Suprême2Volaille'],
  ['e65c3ab9', '2026-11-02T17:30:25', 'Ankylosaurus', 'SR', 'U', 450],
  ['e386fe58', '2026-11-02T17:30:07', 'Diplodocus', 'SR', 'S', 1100, 'toniooa44'],
  ['c1e8e7b9', '2026-11-02T17:29:24', 'Hellfest', 'UR', 'S', 500, 'Tiboo5'],
  ['ca69cb3d', '2026-11-02T17:27:19', 'Marlène Schiappa', 'UR', 'U', 50],
  ['aa1fbbec', '2026-11-02T14:29:51', 'Giganotosaurus', 'SR', 'U', 450],
  ['90f03d6b', '2026-11-02T11:22:25', "Coupe d'Afrique des nations de futsal 2026", 'UR', 'S', 1, 'Wikyrielle'],
  ['6ecffd8c', '2026-11-02T11:18:57', 'Mercedes-Benz Classe SL', 'SR', 'S', 2, 'Hayabuza'],
  ['333c60a5', '2026-11-02T11:18:25', 'Giganotosaurus', 'SR', 'U', 450],
  ['78d395ff', '2026-11-02T11:17:51', 'Ankylosaurus', 'SR', 'U', 450],
  ['67fce3ef', '2026-11-02T11:17:23', 'Sagittarius A*', 'SR', 'U', 500],
  ['cad3dd89', '2026-11-01T23:18:21', 'Armie Hammer', 'UR', 'S', 6, 'xXLeBossDu56Xx'],
  ['8a2dec77', '2026-11-01T23:05:12', 'Sagittarius A*', 'SR', 'U', 500],
  ['c34a0d4c', '2026-11-01T22:59:28', 'Ankylosaurus', 'SR', 'U', 450],
  ['a51ac9af', '2026-11-01T22:57:48', 'Giganotosaurus', 'SR', 'U', 450],
  ['682c4b93', '2026-11-01T22:57:24', 'Allemagne', 'L', 'S', 1900, 'tumlusss'],
  ['7e37e4b0', '2026-11-01T21:35:43', 'Allemagne', 'L', 'U', 1950],
  ['fe4e035e', '2026-11-01T21:35:29', 'Norvège', 'L', 'S', 1950, 'Jeatall'],
  ['46a54a48', '2026-11-01T20:34:05', 'Bucéphale', 'SR', 'S', 13, 'Yunka'],
  ['3f1fd40d', '2026-11-01T20:33:11', 'Giganotosaurus', 'SR', 'S', 485, 'RATpapel'],
  ['2951c4c4', '2026-11-01T20:32:29', 'Pays baltes', 'UR', 'U', 120],
  ['d25f793a', '2026-11-01T15:01:09', 'Norvège', 'L', 'U', 2000],
  ['2d288393', '2026-11-01T15:00:53', 'Allemagne', 'L', 'U', 2000],
  ['46028898', '2026-11-01T14:23:56', 'Papilio rumanzovia', 'C', 'S', 1, 'Drënyll'],
  ['4cd698dc', '2026-11-01T14:23:22', 'Giganotosaurus', 'SR', 'U', 450],
  ['159df01f', '2026-11-01T14:23:03', 'Pays baltes', 'UR', 'U', 120],
  ['ef2b5921', '2026-11-01T11:57:46', "Ronan l'Accusateur", 'SR', 'S', 9, 'Kokonino'],
  ['37bbbec2', '2026-11-01T11:56:06', 'Ankylosaurus', 'SR', 'S', 450, 'jomex'],
  ['ea1fddb8', '2026-11-01T11:22:27', 'Papilio rumanzovia', 'C', 'U', 50],
  ['87f57afe', '2026-11-01T11:21:25', 'Giganotosaurus', 'SR', 'U', 350],
  ['5c4968de', '2026-11-01T10:52:42', 'Triceratops', 'SR', 'S', 1375, 'Ari_ri'],
  ['0a39d46b', '2026-10-31T23:52:08', 'Ankylosaurus', 'SR', 'U', 400]
];

// won[]: [id prefix, end_at (UTC), title, rarity, price, seller]
const WON = [
  ['21911cfe', '2026-11-03T16:02:24', 'Triceratops', 'SR', 1200, 'brunolegros'],
  ['05029b07', '2026-11-03T14:41:21', 'Triceratops', 'SR', 1210, 'nadeshiko'],
  ['ba1e4b74', '2026-11-03T12:00:24', 'Deinonychus', 'SR', 271, 'nonoboc'],
  ['3d952b1b', '2026-11-03T11:02:55', 'Triceratops', 'SR', 1200, 'CuteName'],
  ['e099492d', '2026-11-03T08:03:49', 'Argentinosaurus', 'SR', 111, 'Antonio2116'],
  ['46a50371', '2026-11-03T01:20:44', 'Ryan Gosling', 'L', 3730, 'aym444'],
  ['fb5b3f47', '2026-11-02T21:23:54', 'Giganotosaurus', 'SR', 350, 'Papouchnek'],
  ['81daba9c', '2026-11-02T19:25:31', 'Allosaurus', 'SR', 222, 'Blueberry'],
  ['93834925', '2026-11-02T19:04:23', 'Triceratops', 'SR', 772, 'Snickers'],
  ['d548e463', '2026-11-02T18:48:12', 'Velociraptor', 'SR', 717, 'Grogouille'],
  ['c79ab743', '2026-11-02T16:09:03', 'Albanie', 'L', 970, 'alexinho5'],
  ['b22b7c67', '2026-11-02T13:00:50', 'Tyler Posey', 'UR', 10, 'jndcv'],
  ['722cfe3e', '2026-11-02T10:18:55', 'Diplodocus', 'SR', 2350, 'prospera1234'],
  ['89cfc9a9', '2026-11-01T19:04:24', 'Ankylosaurus', 'SR', 250, 'pliplo13'],
  ['4027128e', '2026-11-01T18:42:02', 'Armie Hammer', 'UR', 2, 'tarl'],
  ['d1a09201', '2026-11-01T11:53:55', 'Giganotosaurus', 'SR', 333, 'Ailurus fulgens'],
  ['1a3562d2', '2026-11-01T11:50:53', 'Giganotosaurus', 'SR', 100, 'Aenergy'],
  ['ef649bea', '2026-11-01T11:38:04', 'Giganotosaurus', 'SR', 300, 'Wikilogrammes'],
  ['b4f1a025', '2026-11-01T02:26:14', 'Allemagne', 'L', 1774, 'Nostrafelix'],
  ['1d6fbbf5', '2026-11-01T02:24:09', 'Norvège', 'L', 1600, 'F4LEXStan'],
  ['f46caad3', '2026-11-01T01:47:05', 'Grenade (pays)', 'SR', 100, 'violenceisbad'],
  ['5b41836c', '2026-11-01T01:44:35', 'Pays baltes', 'UR', 85, 'kerubi'],
  ['83f7ea23', '2026-10-31T22:51:27', 'Ankylosaurus', 'SR', 130, 'PRobin'],
  ['ec1a6967', '2026-10-31T22:25:28', 'Giganotosaurus', 'SR', 127, 'nonogroslolo'],
  ['1729411b', '2026-10-31T21:00:22', 'Ankylosaurus', 'SR', 370, 'AlexiZi'],
  ['887b7118', '2026-10-31T14:38:49', 'Triceratops', 'SR', 900, 'bulox'],
  ['fda70b88', '2026-10-31T14:28:38', 'Tyrannosaurus', 'UR', 1641, 'laure0756'],
  ['d6812c62', '2026-10-31T13:09:18', 'Velociraptor', 'SR', 350, 'picrate'],
  ['cf067cd4', '2026-10-31T11:40:27', 'Triceratops', 'SR', 889, 'snezaa'],
  ['a9def0fb', '2026-10-31T09:42:33', 'Velociraptor', 'SR', 549, 'Himmel_'],
  ['78515964', '2026-10-31T00:53:08', 'Velociraptor', 'SR', 567, 'vedved'],
  ['91e98694', '2026-10-30T21:03:59', 'Ankylosaurus', 'SR', 330, 'SURPRYZ'],
  ['a55e0aa8', '2026-10-30T10:54:16', 'Triceratops', 'SR', 1030, 'MewiSecler'],
  ['6f76e1a5', '2026-10-29T23:15:32', 'Triceratops', 'SR', 910, 'Gasproutine'],
  ['2afd8119', '2026-10-27T17:01:31', 'Afghanistan', 'UR', 286, 'vincentvllm'],
  ['4b69df06', '2026-10-27T12:53:18', 'Mongolie', 'UR', 200, 'titi_13'],
  ['eddf1255', '2026-10-26T16:19:32', 'Azerbaïdjan', 'L', 695, 'Brsurdiegoo'],
  ['963bb3b6', '2026-10-25T04:05:44', 'Hong Kong', 'L', 800, 'hugo35kg']
];

function uuid(prefix, n) {
  return `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function iso(utc) {
  return `${utc}.123456+00:00`;
}

/** Builds an /api/marketplace answer shaped like the real one. */
function apiResponse({ history = HISTORY, won = WON } = {}) {
  return {
    auctions: [],
    page: 1,
    limit: 50,
    hasMore: true,
    selling: [],
    bidding: [],
    history: history.map(([p, end, title, rarity, s, price, buyer], i) => {
      const sold = s === 'S';
      return {
        id: uuid(p, i),
        card_id: `card-${title}`,
        seller_id: ME,
        seller: { id: ME, username: 'Mighty_D_Eagle' },
        status: sold ? 'settled_sold' : 'settled_unsold',
        end_at: iso(end),
        settled_at: iso(end),
        created_at: iso(end),
        base_amount: price,
        listing_base_amount: p === '13c0146a' ? 2000 : price, // repriced listing in the real data
        current_bid: sold ? price : null,
        final_price: sold ? price : null,
        winner_id: sold ? `buyer-${buyer}` : null,
        winner: sold ? { id: `buyer-${buyer}`, username: buyer } : null,
        snapshot_rarity: rarity,
        is_shiny: false,
        card: { id: `card-${title}`, rarity, wikipedia_title: title }
      };
    }),
    won: won.map(([p, end, title, rarity, price, seller], i) => ({
      id: uuid(p, 100 + i),
      card_id: `card-${title}`,
      seller_id: `seller-${seller}`,
      seller: { id: `seller-${seller}`, username: seller },
      status: 'settled_sold',
      end_at: iso(end),
      settled_at: iso(end),
      base_amount: price,
      final_price: price,
      winner_id: ME,
      winner: { id: ME, username: 'Mighty_D_Eagle' },
      snapshot_rarity: rarity,
      is_shiny: false,
      card: { id: `card-${title}`, rarity, wikipedia_title: title }
    })),
    maxConcurrentAuctions: 5,
    mine: true
  };
}

module.exports = { ME, ACHATS_ROWS, VENTES_ROWS, HISTORY, WON, apiResponse, uuid, iso };
