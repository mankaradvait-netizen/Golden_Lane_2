import os
# pyrefly: ignore[missing-import]
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = os.getenv(
        "DATABASE_URL",
        "postgresql+asyncpg://golden:golden_pw@db:5432/golden_lane"
    )
    redis_url: str = os.getenv(
        "REDIS_URL",
        "redis://redis:6379/0"
    )
    jwt_secret: str = os.getenv("JWT_SECRET", "dev-secret-change-me")
    jwt_alg: str = os.getenv("JWT_ALG", "HS256")
    jwt_expire_minutes: int = int(os.getenv("JWT_EXPIRE_MINUTES", "480"))
    cors_origins: str = os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://localhost:8080"
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )


settings = Settings()
