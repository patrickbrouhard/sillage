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
	Mode          string
	Username      string
	Password      string
	AdoptExisting bool
}

// Provision applique l'autorité locale avant l'ouverture du serveur, sans renouveler les sessions inchangées.
func (s *Service) Provision(ctx context.Context, desired *Provisioning) error {
	current, err := s.repository.Owner(ctx)
	if err != nil && !errors.Is(err, ErrUninitialized) {
		return err
	}
	exists := err == nil
	if desired == nil {
		if exists && current.Managed {
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

	if exists {
		if current.Managed && desired.Mode != "managed" {
			return ErrManaged
		}
		if desired.Mode == "bootstrap" {
			// Le bootstrap ne modifie jamais un compte existant, même après récupération locale.
			if current.Username != desired.Username {
				return ErrProvision
			}
			return s.repository.ConfigureOwner(ctx, current, current.Version)
		}
		if !current.Managed && !desired.AdoptExisting {
			return ErrAdoption
		}
	}
	managed := desired.Mode == "managed"
	samePassword := exists && VerifyPassword(current.PasswordHash, desired.Password)
	if exists && current.Managed == managed && current.Username == desired.Username && samePassword {
		return s.repository.ConfigureOwner(ctx, current, current.Version)
	}
	hash := current.PasswordHash
	if !samePassword {
		hash, err = HashPassword(desired.Password)
		if err != nil {
			return err
		}
	}
	return s.repository.ConfigureOwner(ctx, Owner{
		Username:     desired.Username,
		PasswordHash: hash,
		Managed:      managed,
	}, current.Version)
}

// Validate vérifie l'ensemble déclaratif avant toute modification durable.
func (p *Provisioning) Validate() error {
	if p.Mode != "bootstrap" && p.Mode != "managed" {
		return ErrProvision
	}
	if p.AdoptExisting && p.Mode != "managed" {
		return ErrProvision
	}
	if err := validateUsername(p.Username); err != nil {
		return err
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
