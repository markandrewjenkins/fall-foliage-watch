"""Fall-colour traits for common street trees in Victoria, Vancouver and Toronto.

Each entry: common name, autumn hue, leaf-peeping tier (S–D), relative timing and a short note.
Timing classes are priors: the model replaces them with offsets measured from iNaturalist
"Colored Leaves" annotations wherever a genus or species has enough observations.

Hues map to the colours drawn on the map:
  scarlet, red, orange, gold, yellow, purple, bronze, brown.
Tiers:
  S  worth a detour; A  stop the car; B  lovely on a sunny street;
  C  pleasant but forgettable; D  mostly brown.
"""
from __future__ import annotations

import re

HUES = {
    "scarlet": "#c8102e", "red": "#a8322d", "orange": "#e0661b", "gold": "#e8a317",
    "yellow": "#e3c22b", "purple": "#7b2d5b", "bronze": "#9a6324", "brown": "#7a5c3e",
}
TIMING = {"early": -9, "mid": 0, "late": 10, "very late": 18}   # days relative to the regional peak (prior)
TIER_BLURB = {
    "S": "Worth a detour",
    "A": "Stop the car",
    "B": "Lovely on a sunny street",
    "C": "Pleasant but forgettable",
    "D": "Mostly brown",
}

# key: "genus species" (lower case) or "genus" for a genus-wide default
SPECIES: dict[str, dict] = {
    # --- S tier
    "liquidambar styraciflua": dict(common="Sweetgum", hue="purple", tier="S", timing="late",
        note="Every leaf a different colour, purple to scarlet to gold, on one tree. Holds its leaves into December on the coast."),
    "acer rubrum": dict(common="Red maple", hue="scarlet", tier="S", timing="early",
        note="The classic scarlet street maple ('October Glory', 'Red Sunset', 'Armstrong')."),
    "acer x freemanii": dict(common="Freeman maple", hue="scarlet", tier="S", timing="early",
        note="Red × silver maple hybrid; 'Autumn Blaze' is the fiery orange-red one."),
    "acer palmatum": dict(common="Japanese maple", hue="scarlet", tier="S", timing="late",
        note="Crimson to orange lace, late in the season and gorgeous backlit."),
    "ginkgo biloba": dict(common="Ginkgo", hue="yellow", tier="S", timing="late",
        note="Pure butter yellow, then drops almost every leaf in a day or two."),
    "parrotia persica": dict(common="Persian ironwood", hue="orange", tier="S", timing="mid",
        note="Red, orange and yellow on the same branch. Vancouver has thousands."),
    "nyssa sylvatica": dict(common="Black tupelo", hue="scarlet", tier="S", timing="early",
        note="Glossy leaves turn intense scarlet, among the first to colour."),
    "acer saccharum": dict(common="Sugar maple", hue="orange", tier="S", timing="mid",
        note="Ontario's signature: orange, red and gold canopies."),
    "oxydendrum arboreum": dict(common="Sourwood", hue="scarlet", tier="S", timing="early",
        note="Scarlet leaves with lingering white seed sprays."),
    # --- A tier
    "cercidiphyllum japonicum": dict(common="Katsura", hue="gold", tier="A", timing="early",
        note="Apricot-gold leaves that smell like burnt sugar as they fall."),
    "quercus coccinea": dict(common="Scarlet oak", hue="scarlet", tier="A", timing="late",
        note="The reddest oak, late and long-lasting."),
    "amelanchier": dict(common="Serviceberry", hue="orange", tier="A", timing="early",
        note="Small tree, big orange-red show."),
    "acer griseum": dict(common="Paperbark maple", hue="red", tier="A", timing="late",
        note="Red leaves over peeling cinnamon bark."),
    "acer ginnala": dict(common="Amur maple", hue="scarlet", tier="A", timing="early",
        note="Small and intensely scarlet."),
    "acer tataricum": dict(common="Tatarian maple", hue="red", tier="A", timing="early",
        note="Compact maple with orange-red autumn colour."),
    "acer circinatum": dict(common="Vine maple", hue="orange", tier="A", timing="mid",
        note="BC native: orange and red in the understorey."),
    "cornus florida": dict(common="Flowering dogwood", hue="purple", tier="A", timing="mid",
        note="Wine-red leaves and red berries."),
    "cornus kousa": dict(common="Kousa dogwood", hue="red", tier="A", timing="mid",
        note="Red-purple leaves with raspberry-like fruit."),
    "pyrus calleryana": dict(common="Callery pear", hue="purple", tier="A", timing="very late",
        note="Holds green leaves late, then glossy burgundy."),
    "stewartia": dict(common="Stewartia", hue="orange", tier="A", timing="mid",
        note="Orange-red leaves, beautiful bark."),
    "larix": dict(common="Larch", hue="gold", tier="A", timing="mid",
        note="A conifer that turns gold and drops its needles."),
    "metasequoia glyptostroboides": dict(common="Dawn redwood", hue="bronze", tier="A", timing="very late",
        note="Feathery needles turn russet-pink before falling."),
    "taxodium distichum": dict(common="Bald cypress", hue="bronze", tier="A", timing="very late",
        note="Rusty orange needles, late in the season."),
    "zelkova serrata": dict(common="Japanese zelkova", hue="orange", tier="A", timing="mid",
        note="Orange-russet vase-shaped canopy."),
    "rhus": dict(common="Sumac", hue="scarlet", tier="A", timing="early",
        note="Blazing scarlet, usually in parks rather than on streets."),
    "fraxinus americana": dict(common="White ash", hue="purple", tier="A", timing="early",
        note="Purple-bronze ('Autumn Purple'), early to colour and drop."),
    # --- B tier
    "quercus rubra": dict(common="Red oak", hue="red", tier="B", timing="late",
        note="Russet red, late in the season."),
    "quercus palustris": dict(common="Pin oak", hue="bronze", tier="B", timing="late",
        note="Bronze-red, often holding dry leaves into winter."),
    "quercus alba": dict(common="White oak", hue="purple", tier="B", timing="late",
        note="Wine-purple to brown."),
    "fagus": dict(common="Beech", hue="bronze", tier="B", timing="late",
        note="Copper and gold; young trees keep their dry leaves all winter."),
    "betula": dict(common="Birch", hue="yellow", tier="B", timing="early",
        note="Clear yellow early in the season, bright against white bark."),
    "acer macrophyllum": dict(common="Bigleaf maple", hue="yellow", tier="B", timing="mid",
        note="BC's big native maple: huge yellow leaves on the trail."),
    "prunus": dict(common="Cherry & plum", hue="orange", tier="B", timing="early",
        note="Cherries turn orange and red early, a second show on the blossom streets."),
    "liriodendron tulipifera": dict(common="Tulip tree", hue="gold", tier="B", timing="mid",
        note="Big golden-yellow leaves."),
    "acer campestre": dict(common="Hedge maple", hue="yellow", tier="B", timing="mid",
        note="Butter yellow, small leaves."),
    "acer rubrum x saccharinum": dict(common="Freeman maple", hue="scarlet", tier="S", timing="early",
        note="Red × silver maple hybrid."),
    "acer saccharinum": dict(common="Silver maple", hue="yellow", tier="C", timing="mid",
        note="Mostly pale yellow; some trees blush orange."),
    "sorbus": dict(common="Mountain ash", hue="orange", tier="B", timing="early",
        note="Orange-red leaves with red berries."),
    "carpinus": dict(common="Hornbeam", hue="yellow", tier="B", timing="mid",
        note="Yellow-orange; columnar street forms are common."),
    "malus": dict(common="Crabapple", hue="yellow", tier="C", timing="mid",
        note="Yellow-orange leaves, the fruit is the autumn show."),
    "cercis": dict(common="Redbud", hue="yellow", tier="C", timing="mid",
        note="Heart-shaped leaves turn clear yellow."),
    "styrax": dict(common="Snowbell", hue="yellow", tier="C", timing="mid", note="Yellow."),
    "hamamelis": dict(common="Witch hazel", hue="gold", tier="B", timing="mid", note="Yellow-orange."),
    "cotinus": dict(common="Smoke tree", hue="orange", tier="A", timing="mid",
        note="Orange, red and purple ('Grace')."),
    # --- C tier
    "acer platanoides": dict(common="Norway maple", hue="yellow", tier="C", timing="very late",
        note="Toronto's most common street tree: yellow, very late, often green into November."),
    "acer pseudoplatanus": dict(common="Sycamore maple", hue="brown", tier="D", timing="mid",
        note="Brown-yellow, often spotted with tar spot."),
    "gleditsia triacanthos": dict(common="Honey locust", hue="yellow", tier="C", timing="early",
        note="Fine yellow leaflets that vanish down the drains."),
    "tilia": dict(common="Linden", hue="yellow", tier="C", timing="mid", note="Dull yellow."),
    "ulmus": dict(common="Elm", hue="yellow", tier="C", timing="mid", note="Yellow."),
    "celtis": dict(common="Hackberry", hue="yellow", tier="C", timing="mid", note="Pale yellow."),
    "robinia": dict(common="Black locust", hue="yellow", tier="C", timing="mid", note="Yellow."),
    "fraxinus": dict(common="Ash", hue="yellow", tier="C", timing="early",
        note="Yellow, early, and many are gone to emerald ash borer."),
    "fraxinus pennsylvanica": dict(common="Green ash", hue="yellow", tier="C", timing="early", note="Yellow, early."),
    "gymnocladus dioicus": dict(common="Kentucky coffeetree", hue="yellow", tier="C", timing="early", note="Yellow."),
    "juglans": dict(common="Walnut", hue="yellow", tier="C", timing="early", note="Yellow, early to drop."),
    "populus": dict(common="Poplar", hue="yellow", tier="B", timing="mid",
        note="Bright yellow; cottonwoods glow along rivers."),
    "salix": dict(common="Willow", hue="yellow", tier="C", timing="late", note="Yellow."),
    "crataegus": dict(common="Hawthorn", hue="orange", tier="C", timing="mid", note="Orange-red, variable."),
    "syringa": dict(common="Tree lilac", hue="brown", tier="D", timing="late", note="Little colour."),
    "magnolia": dict(common="Magnolia", hue="brown", tier="D", timing="late", note="Yellow-brown."),
    "quercus": dict(common="Oak", hue="bronze", tier="C", timing="late", note="Russet to brown."),
    "quercus garryana": dict(common="Garry oak", hue="brown", tier="D", timing="late",
        note="Victoria's iconic native oak: brown in autumn, magnificent in winter."),
    "acer": dict(common="Maple", hue="orange", tier="B", timing="mid", note="Most maples colour well."),
    "cornus": dict(common="Dogwood", hue="red", tier="B", timing="mid", note="Red-purple."),
    "aesculus": dict(common="Horse chestnut", hue="brown", tier="D", timing="early",
        note="Usually browned by leaf miner before it can colour."),
    "platanus": dict(common="London plane", hue="brown", tier="D", timing="late",
        note="Big tan leaves, more crunch than colour."),
    "catalpa": dict(common="Catalpa", hue="brown", tier="D", timing="early", note="Drops green or brown."),
    "ailanthus": dict(common="Tree of heaven", hue="brown", tier="D", timing="early", note="Little colour."),
    "morus": dict(common="Mulberry", hue="yellow", tier="C", timing="mid", note="Yellow."),
    "castanea": dict(common="Chestnut", hue="bronze", tier="C", timing="late", note="Bronze-yellow."),
    "alnus": dict(common="Alder", hue="brown", tier="D", timing="late", note="Drops green."),
    "davidia": dict(common="Dove tree", hue="brown", tier="D", timing="mid", note="Little colour."),
    "eucommia": dict(common="Hardy rubber tree", hue="brown", tier="D", timing="late", note="Drops green."),
    "laburnum": dict(common="Golden chain", hue="brown", tier="D", timing="mid", note="Little colour."),
    "halesia": dict(common="Silverbell", hue="yellow", tier="C", timing="mid", note="Yellow."),
    "maackia": dict(common="Maackia", hue="brown", tier="D", timing="mid", note="Little colour."),
    "koelreuteria": dict(common="Goldenrain tree", hue="yellow", tier="C", timing="mid", note="Yellow."),
    "phellodendron": dict(common="Amur cork tree", hue="yellow", tier="C", timing="early", note="Yellow."),
    "ostrya": dict(common="Ironwood", hue="yellow", tier="C", timing="mid", note="Yellow."),
    "acer negundo": dict(common="Manitoba maple", hue="yellow", tier="D", timing="mid", note="Weak yellow."),
}

# cultivars that change the colour story
CULTIVARS = {
    "crimson king": dict(hue="purple", note="Purple all summer, bronze in autumn."),
    "autumn purple": dict(hue="purple"),
    "autumn blaze": dict(hue="scarlet"),
    "october glory": dict(hue="scarlet", timing="mid"),
    "red sunset": dict(hue="scarlet"),
    "princeton gold": dict(hue="yellow"),
    "bloodgood": dict(hue="scarlet"),
    "fastigiata": dict(),
}
EVERGREEN = {"thuja", "picea", "pinus", "abies", "tsuga", "pseudotsuga", "chamaecyparis", "cupressus", "juniperus",
             "taxus", "cedrus", "sequoiadendron", "sequoia", "arbutus", "ilex", "quercus ilex", "magnolia grandiflora",
             "eucalyptus", "cupressocyparis", "x cupressocyparis", "araucaria", "calocedrus", "trachycarpus",
             "prunus laurocerasus", "prunus lusitanica", "photinia", "cryptomeria", "pittosporum", "olea", "arbutus menziesii"}

_clean = re.compile(r"[^a-z ]")


def lookup(botanical: str) -> tuple[str, dict] | None:
    """Botanical name from any inventory ('Acer rubrum 'October Glory'', 'ACER RUBRUM', 'Acer x freemanii')
    -> (key, traits) or None for evergreens and unknowns."""
    b = (botanical or "").lower().replace("×", "x").replace("'", " ' ")
    cultivar = ""
    if "'" in b:
        parts = b.split("'")
        cultivar = parts[1].strip() if len(parts) > 1 else ""
        b = parts[0]
    words = [w for w in _clean.sub(" ", b).split() if w not in ("var", "ssp", "subsp", "spp", "sp", "cv")]
    if not words:
        return None
    genus = words[0]
    sp = " ".join(words[:3]) if len(words) > 2 and words[1] == "x" else " ".join(words[:2])
    if sp in EVERGREEN or genus in EVERGREEN:
        return None
    key = sp if sp in SPECIES else genus if genus in SPECIES else None
    if key is None:
        return None
    traits = dict(SPECIES[key])
    for c, over in CULTIVARS.items():
        if c and c in cultivar:
            traits.update(over)
    return key, traits
