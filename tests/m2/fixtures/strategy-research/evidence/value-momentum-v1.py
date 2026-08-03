"""Digest-locked StrategyDefinition source fixture for semantic validation."""


def value_momentum_score(value_score: float, momentum_score: float) -> float:
    """Combine two explicit factor inputs without hidden runtime state."""
    return value_score + momentum_score
