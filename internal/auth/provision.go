package auth

import (
	"context"
	"errors"
)

// Erreurs d'autorité et de concurrence, sans données de configuration.
var (
	ErrManaged      = errors.New("owner is declaratively managed; restore or update its managed configuration")
	ErrAdoption     = errors.New("existing local owner requires adopt_existing=true before declarative management")
	ErrOwnerChanged = errors.New("owner changed concurrently; restart provisioning")
	ErrProvision    = errors.New("invalid owner provisioning")
)

// Provisioning décrit uniquement le provisionnement local ; Password n'est jamais persisté tel quel.
type Provisioning struct {
	Mode           string
	Username       string
	Password       string
	AdoptExisting  bool
	Authentication *Authentication
}

// Provision applique l'autorité locale avant l'ouverture du serveur, sans renouveler les sessions inchangées.
func (s *Service) Provision(ctx context.Context, desired *Provisioning) error {
	current, err := s.repository.Owner(ctx)
	if err != nil && !errors.Is(err, ErrUninitialized) {
		return err
	}
	exists := err == nil
	if desired == nil {
		if exists && (current.Managed || current.Authentication.Managed) {
			return ErrManaged
		}
		if exists {
			return s.repository.ConfigureOwner(ctx, current, current.Version)
		}
		return err
	}
	if err := desired.Validate(); err != nil {
		return err
	}

	target := current
	if !exists {
		target.Authentication.Policy = "local"
	}
	if desired.Authentication == nil {
		if current.Authentication.Managed {
			return ErrManaged
		}
	} else {
		target.Authentication = *desired.Authentication
		target.Authentication.Managed = true
	}
	if exists && current.Managed && desired.Mode != "managed" {
		return ErrManaged
	}
	if exists && !current.Managed && desired.Mode == "managed" && !desired.AdoptExisting {
		return ErrAdoption
	}
	if exists && desired.Authentication != nil && !current.Authentication.Managed && !desired.AdoptExisting {
		return ErrAdoption
	}
	if !exists || desired.Mode == "managed" {
		target.Username = desired.Username
		target.Managed = desired.Mode == "managed"
		if desired.Password == "" {
			target.PasswordHash = ""
		} else if !VerifyPassword(current.PasswordHash, desired.Password) {
			target.PasswordHash, err = HashPassword(desired.Password)
			if err != nil {
				return err
			}
		}
	} else if current.Username != desired.Username {
		return ErrProvision
	}
	if target.Authentication.Policy != "oidc" && target.PasswordHash == "" {
		return ErrPassword
	}
	return s.repository.ConfigureOwner(ctx, target, current.Version)
}

// Validate vérifie l'ensemble déclaratif avant toute modification durable.
func (p *Provisioning) Validate() error {
	if p.Mode != "bootstrap" && p.Mode != "managed" {
		return ErrProvision
	}
	if p.AdoptExisting && p.Mode != "managed" && p.Authentication == nil {
		return ErrProvision
	}
	if err := validateUsername(p.Username); err != nil {
		return err
	}
	if p.Authentication != nil {
		a := p.Authentication
		if a.Policy != "local" && a.Policy != "both" && a.Policy != "oidc" {
			return ErrProvision
		}
		if a.Policy == "local" {
			if a.Issuer != "" || a.Subject != "" || a.ClientID != "" {
				return ErrProvision
			}
		} else if a.Issuer == "" || a.Subject == "" || a.ClientID == "" {
			return ErrProvision
		}
	}
	if p.Password == "" && p.Authentication != nil && p.Authentication.Policy == "oidc" {
		return nil
	}
	return ValidatePassword(p.Password)
}

// LocalAdministration refuse une récupération qui contredirait l'autorité persistée.
func (s *Service) LocalAdministration(ctx context.Context) error {
	owner, err := s.repository.Owner(ctx)
	if err != nil {
		return err
	}
	if owner.Managed {
		return ErrManaged
	}
	return nil
}

// Release rend explicitement l'autorité à l'administration locale et révoque les sessions.
// L'appelant administratif doit avoir retiré la déclaration managed, serveur arrêté.
func (s *Service) Release(ctx context.Context) error {
	owner, err := s.repository.Owner(ctx)
	if err != nil {
		return err
	}
	if !owner.Managed {
		return nil
	}
	owner.Managed = false
	return s.repository.ConfigureOwner(ctx, owner, owner.Version)
}

// RecoverAuthentication rétablit explicitement la politique locale, serveur arrêté, après retrait des déclarations.
// Le secret local doit avoir été libéré séparément s'il était administré durablement.
func (s *Service) RecoverAuthentication(ctx context.Context, password string) error {
	owner, err := s.repository.Owner(ctx)
	if err != nil {
		return err
	}
	if owner.Managed {
		return ErrManaged
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	owner.PasswordHash = hash
	owner.Authentication = Authentication{Policy: "local"}
	return s.repository.ConfigureOwner(ctx, owner, owner.Version)
}
