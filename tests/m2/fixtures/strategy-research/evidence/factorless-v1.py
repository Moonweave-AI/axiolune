"""Digest-locked negative StrategyDefinition source fixture."""


def factorless_score(latest_price: float) -> float:
    """Deliberately has no declared factor dependency in the negative case."""
    return latest_price
